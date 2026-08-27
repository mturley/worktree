package webui

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"sync"
	"sync/atomic"

	"github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/slackpoller"
)

type Server struct {
	DB      *sql.DB
	WebFS   fs.FS // rooted at the dist dir (index.html at top level)
	Port    int
	DevMode bool
	Logger  *log.Logger

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
	emojiMu    sync.Mutex
	emojiCache map[string]string

	groupsMu    sync.Mutex
	groupsCache map[string]slack.UserGroup

	channelMu    sync.Mutex
	channelCache map[string]string

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
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	// API routes are registered by later tasks via registerAPI(mux).
	s.registerAPI(mux)
	if !s.DevMode && s.WebFS != nil {
		mux.HandleFunc("/", s.serveStatic)
	}
	return mux
}

// registerAPI is extended in later tasks. Kept separate so tests can add routes.
func (s *Server) registerAPI(mux *http.ServeMux) {
	// (endpoints added in Tasks 2-6)
	mux.HandleFunc("GET /api/worktrees", s.handleWorktrees)
	mux.HandleFunc("GET /api/timeline", s.handleGlobalTimeline)
	mux.HandleFunc("GET /api/worktree-timeline", s.handleWorktreeTimeline)
	mux.HandleFunc("POST /api/worktrees/poll", s.handlePollWorktree)
	mux.HandleFunc("GET /api/worktree-resources", s.handleWorktreeResources)
	mux.HandleFunc("POST /api/resource-meta", s.handleSetResourceMeta)
	mux.HandleFunc("POST /api/worktree-resources/add", s.handleAddResource)
	mux.HandleFunc("POST /api/worktrees/delete", s.handleDeleteWorktree)
	mux.HandleFunc("POST /api/worktree-resources/remove", s.handleRemoveResource)
	mux.HandleFunc("POST /api/worktree-resources/primary", s.handleSetResourcePrimary)
	mux.HandleFunc("GET /api/stream", s.handleStream)

	// Slack thread/reply/react + image proxies (folded in from slack-mini).
	mux.HandleFunc("GET /api/thread", s.handleThread)
	mux.HandleFunc("POST /api/thread/mark-read", s.handleMarkRead)
	mux.HandleFunc("POST /api/thread/mark-unread", s.handleMarkUnread)
	mux.HandleFunc("POST /api/thread/reply", s.handleReply)
	mux.HandleFunc("POST /api/thread/react", s.handleReact)
	mux.HandleFunc("GET /api/slack-config", s.handleSlackConfig)
	mux.HandleFunc("GET /api/thread-events", s.handleThreadEvents)
	mux.HandleFunc("GET /api/worktree-info", s.handleWorktreeInfo)
	mux.HandleFunc("GET /api/cmux", s.handleCmux)
	mux.HandleFunc("GET /api/cmux-groups", s.handleCmuxGroups)
	mux.HandleFunc("POST /api/cmux/select", s.handleCmuxSelect)
	mux.HandleFunc("GET /api/jira-icon", s.handleJiraIcon)
	mux.HandleFunc("GET /api/slack-avatar", s.handleSlackAvatar)
	mux.HandleFunc("GET /api/slack-emoji", s.handleSlackEmoji)
	mux.HandleFunc("GET /api/slack-file", s.handleSlackFile)
	// Open-host proxy for third-party unfurl images (preview/favicon/footer).
	mux.HandleFunc("GET /api/slack-image", s.handleImage)
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

func (s *Server) Start() error {
	addr := fmt.Sprintf("127.0.0.1:%d", s.Port)
	if s.Logger != nil {
		s.Logger.Printf("worktree UI listening on http://%s", addr)
	}
	return http.ListenAndServe(addr, s.Handler())
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
