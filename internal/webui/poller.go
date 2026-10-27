package webui

import (
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/mturley/watcher"
	wconfig "github.com/mturley/watcher/config"
	watcherdb "github.com/mturley/watcher/db"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/watcher/polllog"
	wslack "github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	wtjira "github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/tasks"
)

const (
	// taskPurgeInterval is how often the sweep for soft-deleted tasks runs.
	taskPurgeInterval = 5 * time.Minute
	// taskPurgeAfter is how long a deleted task stays recoverable (undo)
	// before the sweep removes it for good.
	taskPurgeAfter = time.Hour
)

// StartPolling starts an in-process poll loop: an immediate poll, then one
// every interval, until stop() is called.
func (s *Server) StartPolling(interval time.Duration) (stop func()) {
	s.pollingStarted.Store(true)
	s.initTaskHooks()
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
	sweep := s.purgeDeletedTasks
	if s.purgeSweep != nil {
		sweep = s.purgeSweep
	}
	go runEvery(taskPurgeInterval, done, sweep)
	var once sync.Once
	return func() { once.Do(func() { close(done) }) }
}

// runEvery calls fn once, then every interval, until done closes. It is the
// seam that lets a test drive the purge loop without waiting minutes.
func runEvery(interval time.Duration, done <-chan struct{}, fn func()) {
	fn()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
			fn()
		}
	}
}

// purgeDeletedTasks is one sweep: it removes tasks deleted more than
// taskPurgeAfter ago. The tasks_version bump a purge makes is what tells
// the SSE stream to refresh, so there is nothing else to notify.
func (s *Server) purgeDeletedTasks() {
	n, err := tasks.PurgeDeleted(s.DB, time.Now().Add(-taskPurgeAfter))
	if err != nil {
		s.logger().Printf("tasks.PurgeDeleted: %v", err)
		return
	}
	if n > 0 {
		s.logger().Printf("purged %d deleted task(s)", n)
	}
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
	// Whatever the sources did, failed ones included: resolve blockers from
	// the states the DB now holds (this poll may just have cached a merge or
	// a Done), and reconcile holds.
	s.resolvePass(tasks.ResolveOptions{})
}

func (s *Server) logger() *log.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return log.Default()
}

// logPollWarn records a poll-level warning in the watcher log so it shows in
// the web UI's watcher log modal, not only on stderr.
func (s *Server) logPollWarn(source, msg string) {
	if err := polllog.Write(s.DB, source, "warn", msg); err != nil {
		s.logger().Printf("watcher log write: %v", err)
	}
}

// warnUnconfiguredOnce writes the watcher-log warn row only on the first cycle
// a source is seen unconfigured (or after it was configured again), so a
// permanently unconfigured source does not add a row every poll cycle.
func (s *Server) warnUnconfiguredOnce(source, msg string) {
	s.unconfiguredMu.Lock()
	seen := s.unconfigured[source]
	if s.unconfigured == nil {
		s.unconfigured = map[string]bool{}
	}
	s.unconfigured[source] = true
	s.unconfiguredMu.Unlock()
	if !seen {
		s.logPollWarn(source, msg)
	}
}

// markConfigured resets a source's unconfigured state so a later regression
// warns again.
func (s *Server) markConfigured(source string) {
	s.unconfiguredMu.Lock()
	delete(s.unconfigured, source)
	s.unconfiguredMu.Unlock()
}

// pollAll polls every active pr + jira resource once. Missing creds -> skip
// that source (logged), not an error.
func (s *Server) pollAll() error {
	cfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		return err
	}
	// A service whose watcher is off is skipped before its credentials are
	// even read; its resources keep what the DB already has.
	if prs, _ := watcherdb.ActiveResources(s.DB, "pr"); len(prs) > 0 && s.WatcherEnabled(config.ServiceGitHub) {
		if gh, err := cfg.GitHub(); err == nil {
			s.markConfigured("github")
			if err := ghLib.Poll(s.DB, gh.Token, prs, s.logger()); err != nil {
				s.logger().Printf("github poll: %v", err)
			}
		} else {
			s.logger().Printf("github not configured; skipping %d pr resources", len(prs))
			s.warnUnconfiguredOnce("github", fmt.Sprintf("github not configured; skipping %d pr resources", len(prs)))
		}
	}
	if issues, _ := watcherdb.ActiveResources(s.DB, "jira"); len(issues) > 0 && s.WatcherEnabled(config.ServiceJira) {
		if jc, err := cfg.Jira(); err == nil {
			s.markConfigured("jira")
			auth := wjira.JiraAuth{URL: jc.Host, Email: jc.Email, Token: jc.Token, CustomFields: wtjira.ConfiguredCustomFields(jc.CustomFields)}
			if bcfg, err := wconfig.LoadConfig(wconfig.ConfigDefaultPath()); err == nil {
				auth.BotUsernames = bcfg.JiraBotUsernames()
			}
			if err := wjira.Poll(s.DB, auth, issues, s.logger()); err != nil {
				s.logger().Printf("jira poll: %v", err)
			}
		} else {
			s.logger().Printf("jira not configured; skipping %d jira resources", len(issues))
			s.warnUnconfiguredOnce("jira", fmt.Sprintf("jira not configured; skipping %d jira resources", len(issues)))
		}
	}
	if threads, _ := watcherdb.ActiveResources(s.DB, "slack"); len(threads) > 0 && s.WatcherEnabled(config.ServiceSlack) {
		if sc, err := cfg.Slack(); err == nil {
			s.markConfigured("slack")
			auth := wslack.SlackAuth{Token: sc.Token, Cookie: sc.Cookie, WorkspaceDomain: sc.WorkspaceDomain}
			if err := wslack.Poll(s.DB, auth, threads, s.logger()); err != nil {
				s.logger().Printf("slack poll: %v", err)
			}
		} else {
			s.logger().Printf("slack not configured; skipping %d slack resources", len(threads))
			s.warnUnconfiguredOnce("slack", fmt.Sprintf("slack not configured; skipping %d slack resources", len(threads)))
		}
	}
	// Library Poll prunes only when it runs; with no source configured nothing
	// else would ever trim the warn rows written above.
	polllog.Prune(s.DB, s.logger())
	return nil
}

// pollOne polls a single resource through the matching library poller, so a
// freshly-added resource is enriched into resource_state before the add
// endpoint responds. Reuses the same creds + poller entry points as pollAll.
// Missing creds or a poll error are logged, never fatal (the background
// pollAll will retry).
func (s *Server) pollOne(r watcher.Resource) {
	if svc := serviceForType(r.Type); svc != "" && !s.WatcherEnabled(svc) {
		return // its watcher is off: never contact the service
	}
	cfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		s.logger().Printf("pollOne: load config: %v", err)
		return
	}
	one := []watcher.Resource{r}
	switch r.Type {
	case "pr":
		if gh, err := cfg.GitHub(); err == nil {
			if err := ghLib.Poll(s.DB, gh.Token, one, s.logger()); err != nil {
				s.logger().Printf("pollOne github: %v", err)
			}
		} else {
			s.logger().Printf("pollOne: github not configured")
		}
	case "jira":
		if jc, err := cfg.Jira(); err == nil {
			auth := wjira.JiraAuth{URL: jc.Host, Email: jc.Email, Token: jc.Token, CustomFields: wtjira.ConfiguredCustomFields(jc.CustomFields)}
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
