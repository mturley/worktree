package cmd

import (
	"fmt"
	"io/fs"
	"log"
	"net"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/mturley/watcher/slack"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/slackcreds"
	"github.com/mturley/worktree/internal/slackpoller"
	"github.com/mturley/worktree/internal/webui"
	"github.com/spf13/cobra"
)

var (
	uiPort    int
	uiNoOpen  bool
	uiAPIOnly bool
)

var uiCmd = &cobra.Command{
	Use:     "ui",
	Short:   "Start the worktree web UI",
	GroupID: "worktree",
	RunE:    runUI,
}

func init() {
	uiCmd.Flags().IntVar(&uiPort, "port", 8475, "HTTP server port")
	uiCmd.Flags().BoolVar(&uiNoOpen, "no-open", false, "do not open the browser")
	uiCmd.Flags().BoolVar(&uiAPIOnly, "api-only", false, "serve API only (for use with the Vite dev server)")
	rootCmd.AddCommand(uiCmd)
}

func runUI(cmd *cobra.Command, args []string) error {
	conn, err := wdb.Open()
	if err != nil {
		return fmt.Errorf("opening worktree db: %w", err)
	}
	defer conn.Close()

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
		SlackClient: slackClient, SlackPoller: slackPoller, SlackDomain: slackDomain, SlackCookie: slackCookie}

	// Start the in-process poll loop (Task 4 provides StartPolling).
	stop := srv.StartPolling(2 * time.Minute)
	defer stop()

	if !uiNoOpen && !uiAPIOnly {
		go openBrowserWhenUp(uiPort)
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

func openBrowserWhenUp(port int) {
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	for i := 0; i < 50; i++ {
		c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 100*time.Millisecond)
		if err == nil {
			c.Close()
			openBrowser(url)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func openBrowser(url string) {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = exec.Command("open", url)
	case "linux":
		c = exec.Command("xdg-open", url)
	default:
		return
	}
	_ = c.Start()
}
