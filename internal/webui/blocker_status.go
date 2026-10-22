package webui

import (
	"encoding/json"
	"strings"

	wconfig "github.com/mturley/watcher/config"
	watcherdb "github.com/mturley/watcher/db"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/worktree/internal/config"
	wtjira "github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/tasks"
)

// jiraSearcher is the one Jira call blocker resolution makes;
// *wjira.Client satisfies it.
type jiraSearcher interface {
	SearchSummaries(jql string, max int) ([]wjira.IssueSummary, bool, error)
}

// jiraSearchChunk caps the keys in one `key in (...)` search, well under
// Jira's maxResults ceiling.
const jiraSearchChunk = 50

// initTaskHooks points the tasks package's logging at this server's logger
// and registers the server as the sink for resolutions the tasks package
// makes inside its own writes (a task completed, reopened or deleted, a
// blocker added). Called from Handler and StartPolling; runs once.
func (s *Server) initTaskHooks() {
	s.taskHooksOnce.Do(func() {
		tasks.Logf = s.logger().Printf
		if s.DB != nil {
			tasks.SetResolutionSink(s.DB, s.handleResolutions)
		}
	})
}

// afterTaskWrite runs blocker resolution with the full status lookup, then
// reconciles holds, and hands what changed to handleResolutions. The web
// API calls it after a task write that can change a blocker's condition,
// so a resource blocker resolves at once (task blockers already resolved
// inside the tasks write itself); the poll loop calls it after every pass.
// Errors are logged: the write it follows has committed, and the next pass
// retries.
func (s *Server) afterTaskWrite() {
	if s.DB == nil {
		return
	}
	rs, err := tasks.ResolveBlockers(s.DB, s.blockerStatusLookup())
	if err != nil {
		s.logger().Printf("blockers: %v", err)
	}
	if err := tasks.ReconcileHolds(s.DB); err != nil {
		s.logger().Printf("blockers: %v", err)
	}
	s.handleResolutions(rs)
}

// handleResolutions is where every automatic blocker resolution ends up,
// from the poll loop, afterTaskWrite and the tasks package's write-time
// sink. It is the seam for the "Unblocked" notification (Phase 5, Task 5),
// which will take the resolved ones from here.
func (s *Server) handleResolutions(rs []tasks.Resolution) {
	if len(rs) == 0 {
		return
	}
	if s.onResolutions != nil {
		s.onResolutions(rs)
	}
}

// blockerStatusLookup builds the StatusLookup for one resolution pass. Its
// Jira results are cached for the pass, so a pass makes one search (per
// chunk of keys) however many blockers name Jira issues, and none when no
// blocker does.
func (s *Server) blockerStatusLookup() tasks.StatusLookup {
	l := &blockerLookup{s: s}
	return l.lookup
}

type blockerLookup struct {
	s          *Server
	jiraLoaded bool
	jira       map[string]wjira.IssueSummary // by upper-case key; nil when unavailable
}

func (l *blockerLookup) lookup(typ, id string) (tasks.ResourceStatus, bool) {
	switch typ {
	case "pr":
		return prBlockerStatus(l.s, id)
	case "jira":
		key, ok := wtjira.ParseKey(id)
		if !ok {
			return tasks.ResourceStatus{}, false
		}
		if !l.jiraLoaded {
			l.jiraLoaded = true
			l.jira = l.s.searchBlockerIssues()
		}
		is, ok := l.jira[key]
		if !ok {
			return tasks.ResourceStatus{}, false
		}
		label := is.Status
		if label == "" {
			label = is.StatusCategory
		}
		return tasks.ResourceStatus{Done: is.StatusCategory == "done", Label: label}, true
	}
	// Slack threads and links are resolved by hand.
	return tasks.ResourceStatus{}, false
}

// prBlockerStatus reads a PR's cached state (watcher_resource_state's
// "state": OPEN, MERGED or CLOSED). It never contacts GitHub, so it works
// whatever the GitHub watcher toggle says; a disabled watcher just stops
// the cache from moving. Never polled, or an unknown state: ok=false.
func prBlockerStatus(s *Server, id string) (tasks.ResourceStatus, bool) {
	st, err := watcherdb.GetResourceState(s.DB, "pr", id)
	if err != nil {
		s.logger().Printf("blockers: pr %s state: %v", id, err)
		return tasks.ResourceStatus{}, false
	}
	if st == nil {
		return tasks.ResourceStatus{}, false
	}
	var m struct {
		State string `json:"state"`
	}
	if json.Unmarshal([]byte(st.StateJSON), &m) != nil {
		return tasks.ResourceStatus{}, false
	}
	switch m.State {
	case "MERGED":
		return tasks.ResourceStatus{Done: true, Label: "merged"}, true
	case "CLOSED":
		return tasks.ResourceStatus{Done: true, Label: "closed"}, true
	case "OPEN":
		return tasks.ResourceStatus{Done: false, Label: "open"}, true
	}
	return tasks.ResourceStatus{}, false
}

// searchBlockerIssues looks up every Jira issue a resolvable blocker names,
// returning them by key. It returns nil, and contacts nothing, when the
// Jira watcher is off, Jira is not configured or no blocker names an
// issue. A failed batch search is retried key by key, since one missing or
// forbidden key fails a whole `key in (...)` query; keys that still fail
// are absent (unknown: their blockers keep their last state).
func (s *Server) searchBlockerIssues() map[string]wjira.IssueSummary {
	if !s.WatcherEnabled(config.ServiceJira) {
		return nil
	}
	ids, err := tasks.ResolvableResourceIDs(s.DB, "jira")
	if err != nil {
		s.logger().Printf("blockers: jira keys: %v", err)
		return nil
	}
	var keys []string
	seen := map[string]bool{}
	for _, id := range ids {
		// Validated keys only: they go into JQL verbatim.
		if k, ok := wtjira.ParseKey(id); ok && !seen[k] {
			seen[k] = true
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		return nil
	}
	c, ok := s.blockerJiraSearcher()
	if !ok {
		return nil
	}
	out := map[string]wjira.IssueSummary{}
	add := func(keys []string) error {
		got, _, err := c.SearchSummaries("key in ("+strings.Join(keys, ", ")+")", len(keys))
		if err != nil {
			return err
		}
		for _, is := range got {
			out[strings.ToUpper(is.Key)] = is
		}
		return nil
	}
	for i := 0; i < len(keys); i += jiraSearchChunk {
		chunk := keys[i:min(i+jiraSearchChunk, len(keys))]
		err := add(chunk)
		if err == nil || len(chunk) == 1 {
			if err != nil {
				s.logger().Printf("blockers: jira search %s: %v", chunk[0], err)
			}
			continue
		}
		for _, k := range chunk {
			if err := add([]string{k}); err != nil {
				s.logger().Printf("blockers: jira search %s: %v", k, err)
			}
		}
	}
	return out
}

// blockerJiraSearcher returns the Jira client for blocker lookups, or false
// when Jira is not configured. Callers check the watcher toggle first.
func (s *Server) blockerJiraSearcher() (jiraSearcher, bool) {
	if s.blockerJira != nil {
		return s.blockerJira()
	}
	cfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		return nil, false
	}
	jc, err := cfg.Jira()
	if err != nil {
		return nil, false
	}
	return &wjira.Client{BaseURL: jc.Host, Email: jc.Email, Token: jc.Token}, true
}
