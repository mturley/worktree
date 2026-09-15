package webui

import (
	"database/sql"
	"encoding/json"
	"io/fs"
	"log"
	"net"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/linkmeta"
	"github.com/mturley/worktree/internal/slackpoller"
)

type Server struct {
	DB    *sql.DB
	WebFS fs.FS // rooted at the dist dir (index.html at top level)
	Port    int
	DevMode bool
	Logger  *log.Logger

	// Security is required to serve (Start and Serve refuse a nil one). A
	// Handler built without it skips the Host and session guards, which is
	// what in-process tests rely on.
	Security *Security

	// Slack integration. These are nil/empty when Slack is unconfigured
	// (no credentials in the shared watcher auth.yaml); the Slack handlers
	// guard on SlackClient == nil and return 503 rather than nil-panicking.
	SlackClient slack.Client
	SlackPoller *slackpoller.Poller
	SlackDomain string
	// SlackCookie is the d= session cookie forwarded by the files.slack.com
	// image proxy for authenticated file downloads.
	SlackCookie string

	// pollInFlight guards against concurrent polls (ticker + poll-on-view
	// racing against the same DB/resource set).
	pollInFlight atomic.Bool

	// Slack enrichment caches (workspace emoji, channel names, current user).
	// emojiMu guards the cached map and the negative-cache fields ONLY; it is
	// never held across the emoji.list network call. emojiFetchMu is held
	// across that call instead, so concurrent misses make one Slack request
	// while cache HITS never block behind a request in flight.
	emojiMu        sync.Mutex
	emojiFetchMu   sync.Mutex
	emojiCache     map[string]string
	emojiErr       error
	emojiFailUntil time.Time

	groupsMu    sync.Mutex
	groupsCache map[string]slack.UserGroup

	channelMu    sync.Mutex
	channelCache map[string]string

	// acCache fronts every Slack-backed autocomplete lookup; see
	// autocomplete_cache.go for why it is mandatory. Server is constructed as
	// a bare struct literal by callers (cmd/ui.go and every test), so this is
	// lazily initialised via autocompleteCacheOrInit rather than a
	// constructor.
	acCacheOnce sync.Once
	acCache     *autocompleteCache

	currentUserMu    sync.Mutex
	currentUserID    string
	currentUserKnown bool

	// imageProxyTransport is the RoundTripper the image proxy uses for its
	// outbound fetch. If nil, handleImageProxy falls back to
	// http.DefaultTransport. handleImageProxy always layers its own
	// redirect-blocking CheckRedirect policy on top, regardless of this
	// value, so swapping the transport (e.g. in tests, to trust an
	// httptest server's self-signed TLS cert) can never disable that
	// protection.
	imageProxyTransport http.RoundTripper

	// cmuxList and cmuxListGroups are seams for tests. When nil, the handlers
	// call the real cmux package functions. Package cmux's own exec stub is
	// unexported, so injecting here is the only way to test the available path.
	cmuxList       func() ([]cmux.Workspace, error)
	cmuxListGroups func() ([]cmux.WorkspaceGroup, error)

	// LinkResolver is a seam for tests; nil means a default resolver.
	LinkResolver *linkmeta.Resolver
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	for _, rt := range s.routes() {
		mux.HandleFunc(rt.pattern, rt.handler)
	}
	if !s.DevMode && s.WebFS != nil {
		mux.HandleFunc("/", s.serveStatic)
	}
	return s.wrap(mux)
}

// wrap applies the request guards. Outermost first: the Host allowlist, so
// nothing routes a rebound request; then the request-forgery guard.
func (s *Server) wrap(h http.Handler) http.Handler {
	h = guardMutations(h)
	if s.Security != nil {
		h = hostGuard(s.Security.AllowedHosts, s.Logger, h)
	}
	return h
}

type route struct {
	pattern string
	handler http.HandlerFunc
}

// routes is the API route table. Every entry declares its method, and tests
// iterate it, so a route added here is covered by the auth tests
// automatically.
func (s *Server) routes() []route {
	return []route{
		{"GET /api/worktrees", s.handleWorktrees},
		{"GET /api/timeline", s.handleGlobalTimeline},
		{"GET /api/worktree-timeline", s.handleWorktreeTimeline},
		{"POST /api/worktrees/poll", s.handlePollWorktree},
		{"GET /api/watchers", s.handleWatchers},
		{"POST /api/watchers/poll", s.handleWatchersPoll},
		{"GET /api/worktree-resources", s.handleWorktreeResources},
		{"POST /api/resource-meta", s.handleSetResourceMeta},
		{"POST /api/resource-read", s.handleResourceRead},
		{"POST /api/worktree-resources/add", s.handleAddResource},
		{"POST /api/worktrees/delete", s.handleDeleteWorktree},
		{"POST /api/worktree-resources/remove", s.handleRemoveResource},
		{"POST /api/worktree-resources/primary", s.handleSetResourcePrimary},
		{"GET /api/stream", s.handleStream},

		// Slack thread/reply/react + image proxies (folded in from slack-mini).
		{"GET /api/thread", s.handleThread},
		{"POST /api/thread/mark-read", s.handleMarkRead},
		{"POST /api/thread/mark-unread", s.handleMarkUnread},
		{"POST /api/thread/reply", s.handleReply},
		{"POST /api/thread/react", s.handleReact},
		{"GET /api/slack-config", s.handleSlackConfig},
		{"GET /api/slack-autocomplete", s.handleSlackAutocomplete},
		{"GET /api/thread-events", s.handleThreadEvents},
		{"GET /api/worktree-info", s.handleWorktreeInfo},
		{"GET /api/cmux", s.handleCmux},
		{"GET /api/cmux-groups", s.handleCmuxGroups},
		{"POST /api/cmux/select", s.handleCmuxSelect},
		{"POST /api/cmux/create", s.handleCmuxCreate},
		{"GET /api/jira-icon", s.handleJiraIcon},
		{"GET /api/slack-avatar", s.handleSlackAvatar},
		{"POST /api/worktrees/create", s.handleCreateWorktree},
		{"GET /api/repos", s.handleRepos},
		{"GET /api/repo-dotfiles", s.handleRepoDotfiles},
		{"GET /api/slack-emoji", s.handleSlackEmoji},
		{"GET /api/slack-file", s.handleSlackFile},
		// Open-host proxy for third-party unfurl images (preview/favicon/footer).
		{"GET /api/slack-image", s.handleImage},

		{"POST /api/resource-resolve", s.handleResourceResolve},
		{"GET /api/resource-type", s.handleResourceType},
		// The same open-host image proxy handler as /api/slack-image, under a
		// name that is honest about who is calling it. A link's favicon and
		// preview image are third-party URLs from arbitrary sites, which is
		// exactly what handleImage was built for.
		{"GET /api/link-image", s.handleImage},
	}
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		if info, err := fs.Stat(s.WebFS, r.URL.Path[1:]); err == nil && !info.IsDir() {
			http.FileServer(http.FS(s.WebFS)).ServeHTTP(w, r)
			return
		}
	}
	indexData, err := fs.ReadFile(s.WebFS, "index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(indexData)
}

// listenAddr is the plain-HTTP listener's address. It is always loopback:
// other devices use the HTTPS listener.
func (s *Server) listenAddr() string {
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(s.Port))
}

// Start opens the loopback HTTP listener and, when remote access is
// configured, the HTTPS listener on every interface, then serves both.
func (s *Server) Start() error {
	if err := s.Security.validate(); err != nil {
		return err
	}
	httpLn, err := net.Listen("tcp", s.listenAddr())
	if err != nil {
		return err
	}
	var httpsLn net.Listener
	if s.Security.Remote() {
		// Every interface, loopback included: the .local name resolves to
		// 127.0.0.1 on this machine, so the phone's URL works here too.
		httpsLn, err = net.Listen("tcp", net.JoinHostPort("", strconv.Itoa(s.Security.HTTPSPort)))
		if err != nil {
			httpLn.Close()
			return err
		}
	}
	return s.Serve(httpLn, httpsLn)
}

// Serve serves on listeners that are already open; httpsLn may be nil. It
// returns when either server stops, and closes both.
func (s *Server) Serve(httpLn, httpsLn net.Listener) error {
	if err := s.Security.validate(); err != nil {
		return err
	}
	h := s.Handler()
	errc := make(chan error, 2)

	local := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second}
	if s.Logger != nil {
		s.Logger.Printf("worktree UI listening on http://%s", httpLn.Addr())
	}
	go func() { errc <- local.Serve(httpLn) }()

	var remote *http.Server
	if httpsLn != nil {
		remote = &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second}
		if s.Logger != nil {
			s.Logger.Printf("worktree UI listening for other devices on https://%s", httpsLn.Addr())
		}
		go func() { errc <- remote.ServeTLS(httpsLn, s.Security.CertFile, s.Security.KeyFile) }()
	}

	err := <-errc
	local.Close()
	if remote != nil {
		remote.Close()
	}
	return err
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
