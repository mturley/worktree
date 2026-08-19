package webui

import (
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/mturley/watcher"
	wconfig "github.com/mturley/watcher/config"
	watcherdb "github.com/mturley/watcher/db"
	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	wslack "github.com/mturley/watcher/slack"
	wdb "github.com/mturley/worktree/internal/db"
)

// StartPolling starts an in-process poll loop: an immediate poll, then one
// every interval, until stop() is called.
func (s *Server) StartPolling(interval time.Duration) (stop func()) {
	done := make(chan struct{})
	go func() {
		s.safePollAll()
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				s.safePollAll()
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(done) }) }
}

// safePollAll runs pollAll, skipping if a poll is already in flight. The
// ticker goroutine and poll-on-view (handlePollWorktree) can both call this
// concurrently against the same DB/resource set; the atomic guard ensures at
// most one poll runs at a time, with concurrent callers no-oping rather than
// queuing (a poll-on-view during a long interval poll should return fast).
func (s *Server) safePollAll() {
	if !s.pollInFlight.CompareAndSwap(false, true) {
		return // a poll is already running; skip this one
	}
	defer s.pollInFlight.Store(false)
	if err := s.pollAll(); err != nil {
		s.logger().Printf("poll: %v", err)
	}
}

func (s *Server) logger() *log.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return log.Default()
}

// pollAll polls every active pr + jira resource once. Missing creds -> skip
// that source (logged), not an error.
func (s *Server) pollAll() error {
	cfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		return err
	}
	if prs, _ := watcherdb.ActiveResources(s.DB, "pr"); len(prs) > 0 {
		if gh, err := cfg.GitHub(); err == nil {
			if err := wgithub.Poll(s.DB, gh.Token, prs, s.logger()); err != nil {
				s.logger().Printf("github poll: %v", err)
			}
		} else {
			s.logger().Printf("github not configured; skipping %d pr resources", len(prs))
		}
	}
	if issues, _ := watcherdb.ActiveResources(s.DB, "jira"); len(issues) > 0 {
		if jc, err := cfg.Jira(); err == nil {
			auth := wjira.JiraAuth{URL: jc.Host, Email: jc.Email, Token: jc.Token, CustomFields: jc.CustomFields}
			if bcfg, err := wconfig.LoadConfig(wconfig.ConfigDefaultPath()); err == nil {
				auth.BotUsernames = bcfg.JiraBotUsernames()
			}
			if err := wjira.Poll(s.DB, auth, issues, s.logger()); err != nil {
				s.logger().Printf("jira poll: %v", err)
			}
		} else {
			s.logger().Printf("jira not configured; skipping %d jira resources", len(issues))
		}
	}
	if threads, _ := watcherdb.ActiveResources(s.DB, "slack"); len(threads) > 0 {
		if sc, err := cfg.Slack(); err == nil {
			auth := wslack.SlackAuth{Token: sc.Token, Cookie: sc.Cookie, WorkspaceDomain: sc.WorkspaceDomain}
			if err := wslack.Poll(s.DB, auth, threads, s.logger()); err != nil {
				s.logger().Printf("slack poll: %v", err)
			}
		} else {
			s.logger().Printf("slack not configured; skipping %d slack resources", len(threads))
		}
	}
	return nil
}

// pollOne polls a single resource through the matching library poller, so a
// freshly-added resource is enriched into resource_state before the add
// endpoint responds. Reuses the same creds + poller entry points as pollAll.
// Missing creds or a poll error are logged, never fatal (the background
// pollAll will retry).
func (s *Server) pollOne(r watcher.Resource) {
	cfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		s.logger().Printf("pollOne: load config: %v", err)
		return
	}
	one := []watcher.Resource{r}
	switch r.Type {
	case "pr":
		if gh, err := cfg.GitHub(); err == nil {
			if err := wgithub.Poll(s.DB, gh.Token, one, s.logger()); err != nil {
				s.logger().Printf("pollOne github: %v", err)
			}
		} else {
			s.logger().Printf("pollOne: github not configured")
		}
	case "jira":
		if jc, err := cfg.Jira(); err == nil {
			auth := wjira.JiraAuth{URL: jc.Host, Email: jc.Email, Token: jc.Token, CustomFields: jc.CustomFields}
			if bcfg, err := wconfig.LoadConfig(wconfig.ConfigDefaultPath()); err == nil {
				auth.BotUsernames = bcfg.JiraBotUsernames()
			}
			if err := wjira.Poll(s.DB, auth, one, s.logger()); err != nil {
				s.logger().Printf("pollOne jira: %v", err)
			}
		} else {
			s.logger().Printf("pollOne: jira not configured")
		}
	case "slack":
		if sc, err := cfg.Slack(); err == nil {
			auth := wslack.SlackAuth{Token: sc.Token, Cookie: sc.Cookie, WorkspaceDomain: sc.WorkspaceDomain}
			if err := wslack.Poll(s.DB, auth, one, s.logger()); err != nil {
				s.logger().Printf("pollOne slack: %v", err)
			}
		} else {
			s.logger().Printf("pollOne: slack not configured")
		}
	default:
		s.logger().Printf("pollOne: unknown resource type %q", r.Type)
	}
}

// isWorktreeStale reports whether the worktree's newest event is older than
// staleAfter (or it has no events). Uses the canonical subscriber key
// (wdb.Subscriber(path)) to match watcher_subscriptions rows written by
// resources.Add — a raw "worktree:"+path concat would miss on macOS/symlinked
// homes (same class of bug fixed in Tasks 2 & 3).
func (s *Server) isWorktreeStale(path string, staleAfter time.Duration) bool {
	ts := latestEventTSForSubscriber(s.DB, wdb.Subscriber(path))
	if ts == "" {
		return true
	}
	parsed, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return true
	}
	return time.Since(parsed) > staleAfter
}

// handlePollWorktree: POST /api/worktrees/poll?path=<path> — poll-on-view-if-stale.
func (s *Server) handlePollWorktree(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	if !s.isWorktreeStale(path, time.Minute) {
		writeJSON(w, http.StatusOK, map[string]bool{"polled": false})
		return
	}
	// Poll just this worktree's resources by filtering active resources.
	s.safePollAll() // simplest correct behavior: poll all; per-resource filtering is an optimization
	writeJSON(w, http.StatusOK, map[string]bool{"polled": true})
}
