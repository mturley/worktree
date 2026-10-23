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

// initTaskHooks points the tasks package's logging at this server's
// logger. Called from Handler and StartPolling; runs once.
func (s *Server) initTaskHooks() {
	s.taskHooksOnce.Do(func() { tasks.Logf = s.logger().Printf })
}

// afterTaskWrite is what the web API runs after a task write that can
// change a blocker's condition: a resolution pass that never touches the
// network (PR state from the DB cache, Jira statuses as the last poll pass
// fetched them), then hold reconciliation. A checkbox click must never
// wait on Jira: the poll loop is the only caller that searches it
// (resolvePass(true)). Task blockers were already resolved inside the
// tasks write itself.
func (s *Server) afterTaskWrite() { s.resolvePass(false) }

// resolvePass runs ResolveBlockers, then ReconcileHolds. With network, the
// pass searches Jira (refreshing the cached statuses); without, it reads
// only the DB and that cache. Errors are logged: the write it follows has
// committed, and the next pass retries. What it resolves needs no handing
// on: the notifier finds the system events it wrote (notify_unblock.go).
func (s *Server) resolvePass(network bool) {
	if s.DB == nil {
		return
	}
	if _, err := tasks.ResolveBlockers(s.DB, s.blockerStatusLookup(network)); err != nil {
		s.logger().Printf("blockers: %v", err)
	}
	if err := tasks.ReconcileHolds(s.DB); err != nil {
		s.logger().Printf("blockers: %v", err)
	}
}

// blockerStatusLookup builds the StatusLookup for one resolution pass.
// With network, the pass's first Jira question runs the searches (one per
// chunk of keys, however many blockers name Jira issues, and none when no
// blocker does) and merges what they found into the server's Jira status
// cache; without, it answers Jira from that cache alone. Either way the
// pass sees one fixed set of Jira answers.
func (s *Server) blockerStatusLookup(network bool) tasks.StatusLookup {
	l := &blockerLookup{s: s, network: network}
	return l.lookup
}

type blockerLookup struct {
	s          *Server
	network    bool
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
		l.loadJira()
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

// loadJira fills l.jira once per pass: from a search (network), or from
// the statuses earlier searches found. Nothing, while the Jira watcher is
// off: every Jira blocker then keeps its last state.
func (l *blockerLookup) loadJira() {
	if l.jiraLoaded {
		return
	}
	l.jiraLoaded = true
	if !l.s.WatcherEnabled(config.ServiceJira) {
		return
	}
	if l.network {
		l.jira = l.s.searchBlockerIssues()
		l.s.storeJiraStatuses(l.jira)
		return
	}
	l.jira = l.s.cachedJiraStatuses()
}

// storeJiraStatuses merges a search's results into the server's Jira
// status cache. A key the search did not answer keeps its previous status.
func (s *Server) storeJiraStatuses(found map[string]wjira.IssueSummary) {
	if len(found) == 0 {
		return
	}
	s.jiraStatusMu.Lock()
	defer s.jiraStatusMu.Unlock()
	if s.jiraStatus == nil {
		s.jiraStatus = map[string]wjira.IssueSummary{}
	}
	for k, is := range found {
		s.jiraStatus[k] = is
	}
}

// cachedJiraStatuses is a copy of the Jira status cache.
func (s *Server) cachedJiraStatuses() map[string]wjira.IssueSummary {
	s.jiraStatusMu.Lock()
	defer s.jiraStatusMu.Unlock()
	out := make(map[string]wjira.IssueSummary, len(s.jiraStatus))
	for k, is := range s.jiraStatus {
		out[k] = is
	}
	return out
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
// issue. Only the poll loop calls it. Keys no search answered are absent
// (unknown: their blockers keep their last state).
//
// One missing or forbidden key makes Jira reject a whole `key in (...)`
// query with a 400, so a chunk that fails with a 400 is retried key by key.
// Any other failure (a transport error, a timeout, a 401, a 5xx) would fail
// every key alike, so the search stops there rather than paying the
// timeout once per key.
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
	search := func(keys []string) error {
		got, _, err := c.SearchSummaries("key in ("+strings.Join(keys, ", ")+")", len(keys))
		if err != nil {
			s.logger().Printf("blockers: jira search %s: %v", strings.Join(keys, ","), err)
			return err
		}
		for _, is := range got {
			out[strings.ToUpper(is.Key)] = is
		}
		return nil
	}
	for i := 0; i < len(keys); i += jiraSearchChunk {
		chunk := keys[i:min(i+jiraSearchChunk, len(keys))]
		err := search(chunk)
		switch {
		case err == nil:
			continue
		case !isJiraBadRequest(err):
			return out // Jira is unreachable or refusing us: stop
		case len(chunk) == 1:
			continue // that key is bad; the next chunk may be fine
		}
		for _, k := range chunk {
			if err := search([]string{k}); err != nil && !isJiraBadRequest(err) {
				return out
			}
		}
	}
	return out
}

// isJiraBadRequest reports whether a wjira error is an HTTP 400. wjira
// returns only an untyped `fmt.Errorf("API returned status %d: %s", ...)`,
// and changing the watcher library is out of scope here, so this matches
// the text.
func isJiraBadRequest(err error) bool {
	return err != nil && strings.Contains(err.Error(), "status 400")
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
