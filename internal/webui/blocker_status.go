package webui

import (
	"encoding/json"

	watcherdb "github.com/mturley/watcher/db"
	"github.com/mturley/worktree/internal/tasks"
)

// initTaskHooks points the tasks package's logging at this server's
// logger. Called from Handler and StartPolling; runs once.
func (s *Server) initTaskHooks() {
	s.taskHooksOnce.Do(func() { tasks.SetLogf(s.logger().Printf) })
}

// afterTaskWrite is what the web API runs after a task write that can
// change a blocker's condition: a resolution pass (PR and Jira state from
// the DB cache), then hold reconciliation. Task blockers were already
// resolved inside the tasks write itself.
func (s *Server) afterTaskWrite() { s.resolvePass(tasks.ResolveOptions{}) }

// afterBlockerAdd is afterTaskWrite for the request that added blocker id:
// if this pass resolves it (a PR already merged), the resolution is marked
// on_add and sends no Unblocked notification, since it only answers the
// user's own click.
func (s *Server) afterBlockerAdd(id int64) {
	s.resolvePass(tasks.ResolveOptions{OnAddBlocker: id})
}

// resolvePass runs ResolveBlockers, then ReconcileHolds. It reads only the
// DB: PR and Jira blockers resolve from the state the watcher pollers cached
// (their task: hold subscriptions keep them polled), so it never contacts
// GitHub or Jira. Errors are logged: the write it follows has committed,
// and the next pass retries. What it resolves needs no handing on: the
// notifier finds the system events it wrote (notify_unblock.go).
//
// resolveMu holds for the whole pass: lookup, resolve, reconcile.
// ResolveBlockers re-reads each blocker inside its transaction, but it acts
// on the statuses its lookup read before it: without the lock, a web pass
// that looked up "open" just before the poll's pass saw "merged" would then
// unresolve the blocker (and the poll's next pass resolve it again,
// notifying twice). Another process (the CLI) never looks resources up, so
// it cannot race this way.
func (s *Server) resolvePass(opts tasks.ResolveOptions) {
	if s.DB == nil {
		return
	}
	s.resolveMu.Lock()
	defer s.resolveMu.Unlock()
	lookup := s.blockerStatusLookup
	if s.blockerLookupFor != nil {
		lookup = s.blockerLookupFor()
	}
	if _, err := tasks.ResolveBlockersWith(s.DB, lookup, opts); err != nil {
		s.logger().Printf("blockers: %v", err)
	}
	if err := tasks.ReconcileHolds(s.DB); err != nil {
		s.logger().Printf("blockers: %v", err)
	}
}

// blockerStatusLookup is the tasks.StatusLookup for a resolution pass: PR
// and Jira blockers from their cached state, anything else unknown (Slack
// threads and links are resolved by hand).
func (s *Server) blockerStatusLookup(typ, id string) (tasks.ResourceStatus, bool) {
	switch typ {
	case "pr":
		return prBlockerStatus(s, id)
	case "jira":
		return jiraBlockerStatus(s, id)
	}
	return tasks.ResourceStatus{}, false
}

// jiraBlockerStatus reads a Jira issue's cached state (watcher_resource_state's
// "status_category": new, indeterminate or done, and "status", the
// workflow's own name for it). Like prBlockerStatus it never contacts Jira.
// Done iff the category is "done"; the label is the status name. Never
// polled, or a row cached before watcher v0.16.0 added the category (until
// the next poll rewrites it): ok=false, and the blocker keeps its last state.
func jiraBlockerStatus(s *Server, id string) (tasks.ResourceStatus, bool) {
	st, err := watcherdb.GetResourceState(s.DB, "jira", id)
	if err != nil {
		s.logger().Printf("blockers: jira %s state: %v", id, err)
		return tasks.ResourceStatus{}, false
	}
	if st == nil {
		return tasks.ResourceStatus{}, false
	}
	var m struct {
		Status         string `json:"status"`
		StatusCategory string `json:"status_category"`
	}
	if json.Unmarshal([]byte(st.StateJSON), &m) != nil || m.StatusCategory == "" {
		return tasks.ResourceStatus{}, false
	}
	label := m.Status
	if label == "" {
		label = m.StatusCategory
	}
	return tasks.ResourceStatus{Done: m.StatusCategory == "done", Label: label}, true
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
