package cmd

import (
	"database/sql"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/discovery"
	"github.com/mturley/worktree/internal/netdetect"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/slackcreds"
	"github.com/mturley/worktree/internal/slackpoller"
	"github.com/mturley/worktree/internal/uisession"
	"github.com/mturley/worktree/internal/webui"
	"github.com/spf13/cobra"
)

// defaultUIPort is the port `worktree ui` binds by default, and the only
// port other commands probe when looking for an already-running UI.
const defaultUIPort = 8475

var (
	uiPort          int
	uiNoOpen        bool
	uiAPIOnly       bool
	uiLocalOnly     bool
	uiRevokeAll     bool
	uiRemovedBind   string
	uiRemovedAssume bool
)

var uiCmd = &cobra.Command{
	Use:     "ui",
	Short:   "Start the worktree web UI",
	GroupID: "worktree",
	RunE:    runUI,
}

func init() {
	uiCmd.Flags().IntVar(&uiPort, "port", defaultUIPort, "HTTP server port (always bound to 127.0.0.1)")
	uiCmd.Flags().BoolVar(&uiNoOpen, "no-open", false, "do not open the browser")
	uiCmd.Flags().BoolVar(&uiAPIOnly, "api-only", false, "serve API only (for use with the Vite dev server); implies --local-only")
	uiCmd.Flags().BoolVar(&uiLocalOnly, "local-only", false, "do not start the HTTPS listener for other devices")
	uiCmd.Flags().BoolVar(&uiRevokeAll, "revoke-all-sessions", false, "log out every device, then exit")
	// Removed. Registered only so checkRemovedFlags can explain.
	uiCmd.Flags().StringVar(&uiRemovedBind, "bind", "", "removed; see worktree setup")
	uiCmd.Flags().BoolVar(&uiRemovedAssume, "yes", false, "removed; see worktree setup")
	_ = uiCmd.Flags().MarkHidden("bind")
	_ = uiCmd.Flags().MarkHidden("yes")
	rootCmd.AddCommand(uiCmd)
}

func runUI(cmd *cobra.Command, args []string) error {
	if err := checkRemovedFlags(cmd); err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	conn, err := wdb.Open()
	if err != nil {
		return fmt.Errorf("opening worktree db: %w", err)
	}
	defer conn.Close()
	sessions := &uisession.Store{DB: conn}

	if uiRevokeAll {
		n, err := sessions.RevokeAll()
		if err != nil {
			return fmt.Errorf("revoking sessions: %w", err)
		}
		fmt.Printf("Logged out %d session(s). Every device must log in again.\n", n)
		return nil
	}

	// If a worktree UI is already listening on the port, don't abort with an
	// "address already in use" error — just open the running one in the browser
	// (unless --no-open / --api-only) and exit successfully.
	if serverAlreadyListening(uiPort) {
		openURL := fmt.Sprintf("http://127.0.0.1:%d%s", uiPort, detailPathForCwd(conn))
		fmt.Printf("worktree UI already running on %s — opening in browser\n", openURL)
		if !uiNoOpen && !uiAPIOnly {
			openBrowser(openURL)
		}
		return nil
	}

	sec, err := buildSecurity(cfg.UI, sessions, uiLocalOnly || uiAPIOnly)
	if err != nil {
		return err
	}
	warnConfigPermissions(config.ConfigPath(), os.Stderr)

	var webFS fs.FS
	if !uiAPIOnly {
		sub, err := fs.Sub(globalWebFS, "ui/dist")
		if err != nil {
			return fmt.Errorf("locating embedded web assets: %w", err)
		}
		if !hasBuiltUI(sub) {
			return fmt.Errorf("web UI not built. Run 'make build-web' first")
		}
		webFS = sub
	}

	logger := log.New(os.Stderr, "[worktree-ui] ", log.LstdFlags)

	if _, err := sessions.DeleteExpired(); err != nil {
		logger.Printf("deleting expired sessions: %v", err)
	}
	if sec.Remote() {
		if msg, err := certCoverageWarning(sec.CertFile, netdetect.Candidates()); err != nil {
			logger.Printf("warning: reading the HTTPS certificate: %v", err)
		} else if msg != "" {
			logger.Printf("warning: %s", msg)
		}
		if u := cfg.UI.RemoteURL(); u != "" {
			logger.Printf("open on other devices: %s", u)
		}
	}

	// Build the Slack client + per-thread poller best-effort. Slack being
	// unconfigured must NOT block the UI: the Slack tab is simply unavailable
	// (its handlers return 503) while everything else works.
	var slackClient slack.Client
	var slackPoller *slackpoller.Poller
	var slackDomain, slackCookie string
	if token, cookie, domain, err := slackcreds.Load(); err == nil {
		slackClient = slack.New(token, cookie)
		slackDomain = domain
		slackCookie = cookie
		slackPoller = slackpoller.New(slackClient, 8*time.Second, time.Now)
		defer slackPoller.Close()
	} else {
		logger.Printf("Slack not configured (%v); Slack tab will be unavailable", err)
	}

	srv := &webui.Server{DB: conn, WebFS: webFS, Port: uiPort, DevMode: uiAPIOnly, Logger: logger,
		SlackClient: slackClient, SlackPoller: slackPoller, SlackDomain: slackDomain, SlackCookie: slackCookie,
		Security: sec}

	// Start the in-process poll loop (Task 4 provides StartPolling).
	stop := srv.StartPolling(2 * time.Minute)
	defer stop()

	if !uiNoOpen && !uiAPIOnly {
		go openBrowserWhenUp(uiPort, detailPathForCwd(conn))
	}
	return srv.Start()
}

// hasBuiltUI reports whether the embedded dist has real content (not just .gitkeep).
func hasBuiltUI(sub fs.FS) bool {
	entries, err := fs.ReadDir(sub, ".")
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.Name() != ".gitkeep" {
			return true
		}
	}
	return false
}

// serverAlreadyListening reports whether something is already accepting TCP
// connections on 127.0.0.1:port — used to detect an already-running worktree
// UI so we open it instead of failing to bind.
func serverAlreadyListening(port int) bool {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// runningUIDetailURL returns the URL of the worktree UI's detail page for
// wtPath when a worktree UI is listening on the default port, or "" when none
// is running (or the registry can't be read). Used by the cmux
// workspace-creation flow to add a tab pointing at the new worktree.
//
// It deliberately probes only defaultUIPort: `worktree ui` records its port
// nowhere, so a UI started with a custom --port is simply not detected and
// callers fall back to their no-UI behavior.
func runningUIDetailURL(conn *sql.DB, wtPath string) string {
	if conn == nil || !serverAlreadyListening(defaultUIPort) {
		return ""
	}
	entries, err := registry.List(conn)
	if err != nil {
		return ""
	}
	return uiDetailURL(defaultUIPort, wtPath, entries)
}

// uiDetailURL builds the absolute URL of the worktree UI's detail page for
// wtPath, falling back to the UI home page when wtPath has no registry entry.
func uiDetailURL(port int, wtPath string, entries []registry.Entry) string {
	return fmt.Sprintf("http://127.0.0.1:%d%s", port, detailPathForToplevel(wtPath, entries))
}

func openBrowserWhenUp(port int, path string) {
	openURL := fmt.Sprintf("http://127.0.0.1:%d%s", port, path)
	for i := 0; i < 50; i++ {
		if serverAlreadyListening(port) {
			openBrowser(openURL)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// detailPathForCwd returns the path (relative to the UI's origin) that the
// browser should be opened to: a worktree's detail page when the current
// working directory is inside a worktree tracked in the registry, or "/"
// (the home page) otherwise.
func detailPathForCwd(conn *sql.DB) string {
	cwd, err := os.Getwd()
	if err != nil {
		return "/"
	}
	toplevel, ok := discovery.IsInsideWorktree(cwd)
	if !ok {
		return "/"
	}
	entries, err := registry.List(conn)
	if err != nil {
		return "/"
	}
	return detailPathForToplevel(toplevel, entries)
}

// detailPathForToplevel matches a git toplevel path (as returned by
// discovery.IsInsideWorktree) against a list of registry entries, canonicalizing
// both sides via wdb.Subscriber so that symlink differences between the git
// toplevel and the path recorded at worktree-creation time don't cause a
// false miss. Returns the detail page path for the matching entry, or "/" if
// no registry entry matches.
func detailPathForToplevel(toplevel string, entries []registry.Entry) string {
	target := wdb.Subscriber(toplevel)
	for _, e := range entries {
		if wdb.Subscriber(e.Path) == target {
			return "/worktree/" + url.PathEscape(e.Path) +
				"?" + HomeMarkerParam + "=" + url.QueryEscape(e.Path)
		}
	}
	return "/"
}

// HomeMarkerParam tells the web UI that this tab was opened FOR a particular
// worktree, so it can offer a way back after you navigate away.
//
// It carries the PATH, and the UI keeps it on every URL it navigates to
// rather than reading it once and cleaning up. A bare flag would do only
// while the path is still in the pathname, and storing it browser-side does
// not survive a cmux pane sleeping and being restored — the pane comes back
// with a URL and nothing else. See ui/src/lib/homeWorktree.ts.
//
// Only ever appended to a worktree detail path. The home page is not opened
// "for" anything, and marking it would leave a tab pointing back at itself.
const HomeMarkerParam = "home"

// browserOpenCommand returns the command+args to open url. Inside cmux
// (CMUX_WORKSPACE_ID set) it uses `cmux open` so the URL lands in a cmux
// browser pane; otherwise the platform opener (`open` on macOS, `xdg-open`
// on Linux). Returns nil when there's no opener for the platform.
func browserOpenCommand(url string) []string {
	if os.Getenv("CMUX_WORKSPACE_ID") != "" {
		return []string{"cmux", "open", url}
	}
	switch runtime.GOOS {
	case "darwin":
		return []string{"open", url}
	case "linux":
		return []string{"xdg-open", url}
	default:
		return nil
	}
}

func openBrowser(url string) {
	argv := browserOpenCommand(url)
	if argv == nil {
		return
	}
	_ = exec.Command(argv[0], argv[1:]...).Start()
}
