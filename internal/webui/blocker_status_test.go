package webui

import (
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	watcherdb "github.com/mturley/watcher/db"
	"github.com/mturley/worktree/internal/tasks"
)

func mustBlock(t *testing.T, s *Server, taskID int64, typ, id string) tasks.Blocker {
	t.Helper()
	b, err := tasks.AddBlocker(s.DB, webUser, taskID,
		tasks.BlockerTarget{Kind: tasks.BlockerResource, ResourceType: typ, ResourceID: id})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func blockerOf(t *testing.T, s *Server, taskID int64) tasks.Blocker {
	t.Helper()
	bs, err := tasks.Blockers(s.DB, taskID)
	if err != nil || len(bs) != 1 {
		t.Fatalf("Blockers(%d) = %+v, %v", taskID, bs, err)
	}
	return bs[0]
}

func setPRState(t *testing.T, s *Server, id, state string) {
	t.Helper()
	must(t, watcherdb.UpsertResourceState(s.DB, "pr", id, `{"title":"T","state":"`+state+`"}`, "2026-01-01T00:00:00Z", "x"))
}

func TestBlockerLookupPRState(t *testing.T) {
	t.Parallel()
	s, _ := tasksServer(t)
	l := s.blockerStatusLookup
	if _, ok := l("pr", "o/r#1"); ok {
		t.Fatal("never-polled PR is known")
	}
	for state, want := range map[string]tasks.ResourceStatus{
		"MERGED": {Done: true, Label: "merged"},
		"CLOSED": {Done: true, Label: "closed"},
		"OPEN":   {Done: false, Label: "open"},
	} {
		setPRState(t, s, "o/r#1", state)
		if got, ok := s.blockerStatusLookup("pr", "o/r#1"); !ok || got != want {
			t.Fatalf("%s: lookup = %+v, %v; want %+v", state, got, ok, want)
		}
	}
	for _, typ := range []string{"slack", "link"} {
		if _, ok := l(typ, "x"); ok {
			t.Fatalf("%s lookup is known", typ)
		}
	}
}

func TestPRBlockerMergedThenReopened(t *testing.T) {
	t.Parallel()
	s, _ := tasksServer(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "A"})
	mustBlock(t, s, tk.ID, "pr", "o/r#4498")

	setPRState(t, s, "o/r#4498", "MERGED")
	s.afterTaskWrite()
	if bl := blockerOf(t, s, tk.ID); bl.ResolvedAt == "" || bl.ResolvedReason != "merged" {
		t.Fatalf("after merge, blocker = %+v", bl)
	}

	setPRState(t, s, "o/r#4498", "OPEN")
	s.afterTaskWrite()
	if bl := blockerOf(t, s, tk.ID); bl.ResolvedAt != "" {
		t.Fatalf("after reopen, blocker = %+v", bl)
	}
}

func setJiraState(t *testing.T, s *Server, key, stateJSON string) {
	t.Helper()
	must(t, watcherdb.UpsertResourceState(s.DB, "jira", key, stateJSON, "2026-01-01T00:00:00Z", "x"))
}

func TestBlockerLookupJiraState(t *testing.T) {
	t.Parallel()
	s, _ := tasksServer(t)
	if _, ok := s.blockerStatusLookup("jira", "ABC-1"); ok {
		t.Fatal("never-polled issue is known")
	}
	for _, c := range []struct {
		state string
		want  tasks.ResourceStatus
		ok    bool
	}{
		{`{"status":"Done","status_category":"done"}`, tasks.ResourceStatus{Done: true, Label: "Done"}, true},
		{`{"status":"Closed","status_category":"done"}`, tasks.ResourceStatus{Done: true, Label: "Closed"}, true},
		{`{"status":"In Progress","status_category":"indeterminate"}`, tasks.ResourceStatus{Label: "In Progress"}, true},
		{`{"status":"New","status_category":"new"}`, tasks.ResourceStatus{Label: "New"}, true},
		{`{"status_category":"done"}`, tasks.ResourceStatus{Done: true, Label: "done"}, true},
		// Cached before watcher v0.16.0 added the category: unknown.
		{`{"status":"Done"}`, tasks.ResourceStatus{}, false},
		{`{"status":"Done","status_category":""}`, tasks.ResourceStatus{}, false},
		{`not json`, tasks.ResourceStatus{}, false},
	} {
		setJiraState(t, s, "ABC-1", c.state)
		got, ok := s.blockerStatusLookup("jira", "ABC-1")
		if ok != c.ok || got != c.want {
			t.Fatalf("%s: lookup = %+v, %v; want %+v, %v", c.state, got, ok, c.want, c.ok)
		}
	}
}

func TestJiraBlockerResolvesFromCachedState(t *testing.T) {
	t.Parallel()
	s, _ := tasksServer(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "A"})
	mustBlock(t, s, tk.ID, "jira", "ABC-1")

	setJiraState(t, s, "ABC-1", `{"status":"In Review","status_category":"indeterminate"}`)
	s.afterTaskWrite()
	if bl := blockerOf(t, s, tk.ID); bl.ResolvedAt != "" {
		t.Fatalf("not done, blocker = %+v", bl)
	}

	setJiraState(t, s, "ABC-1", `{"status":"Done","status_category":"done"}`)
	s.afterTaskWrite()
	if bl := blockerOf(t, s, tk.ID); bl.ResolvedAt == "" || bl.ResolvedReason != "Done" {
		t.Fatalf("after Done, blocker = %+v", bl)
	}

	// A row without the category is unknown: the blocker keeps its state.
	setJiraState(t, s, "ABC-1", `{"status":"Reopened"}`)
	s.afterTaskWrite()
	if bl := blockerOf(t, s, tk.ID); bl.ResolvedAt == "" {
		t.Fatalf("unknown state unresolved the blocker: %+v", bl)
	}

	setJiraState(t, s, "ABC-1", `{"status":"Reopened","status_category":"indeterminate"}`)
	s.afterTaskWrite()
	if bl := blockerOf(t, s, tk.ID); bl.ResolvedAt != "" {
		t.Fatalf("after reopen, blocker = %+v", bl)
	}
}

func TestPollResolvesJiraBlockerFromCachedState(t *testing.T) {
	home := t.TempDir()
	t.Setenv("WATCHER_HOME", home)
	must(t, os.WriteFile(filepath.Join(home, "auth.yaml"), []byte(":\tnot yaml: ["), 0o600))
	s, _ := tasksServer(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "A"})
	mustBlock(t, s, tk.ID, "jira", "ABC-1")
	setJiraState(t, s, "ABC-1", `{"status":"Done","status_category":"done"}`)
	s.safePollAll()
	if bl := blockerOf(t, s, tk.ID); bl.ResolvedAt == "" || bl.ResolvedReason != "Done" {
		t.Fatalf("poll did not resolve: %+v", bl)
	}
}

func TestTaskWriteUnblocks(t *testing.T) {
	t.Parallel()
	s, _ := tasksServer(t)
	a, b := mustTask(t, s, tasks.NewTask{Title: "A"}), mustTask(t, s, tasks.NewTask{Title: "B"})
	if _, err := tasks.AddBlocker(s.DB, webUser, a.ID, tasks.BlockerTarget{Kind: tasks.BlockerTask, BlockingTaskID: b.ID}); err != nil {
		t.Fatal(err)
	}

	rec := serveTasks(t, s, "POST", "/api/tasks/state", map[string]any{"id": b.ID, "state": "done"})
	if rec.Code != 200 {
		t.Fatalf("state: %d %s", rec.Code, rec.Body)
	}
	if bl := blockerOf(t, s, a.ID); bl.ResolvedAt == "" || bl.ResolvedReason != "done" {
		t.Fatalf("blocker = %+v", bl)
	}
	if tk, _ := tasks.Get(s.DB, a.ID); tk.Blocked {
		t.Fatal("A still blocked")
	}
}

func TestPollRunsResolverEvenWhenPollFails(t *testing.T) {
	home := t.TempDir()
	t.Setenv("WATCHER_HOME", home)
	// An unreadable auth.yaml makes pollAll fail before any source runs.
	must(t, os.WriteFile(filepath.Join(home, "auth.yaml"), []byte(":\tnot yaml: ["), 0o600))
	s, _ := tasksServer(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "A"})
	mustBlock(t, s, tk.ID, "pr", "o/r#1")
	setPRState(t, s, "o/r#1", "MERGED")
	if err := s.pollAll(); err == nil {
		t.Fatal("pollAll succeeded; the test needs it to fail")
	}
	s.safePollAll()
	if bl := blockerOf(t, s, tk.ID); bl.ResolvedAt == "" {
		t.Fatalf("poll did not resolve: %+v", bl)
	}
}

func mustBlockers(t *testing.T, s *Server, taskID int64) []tasks.Blocker {
	t.Helper()
	bs, err := tasks.Blockers(s.DB, taskID)
	if err != nil {
		t.Fatal(err)
	}
	return bs
}

// Two passes in one process, the poll's and a web write's, must not
// interleave as "stale lookup, then the poll commits, then the stale pass
// unresolves": resolveMu serialises whole passes.
func TestConcurrentResolvePassesNeverUnresolveFromAStaleLookup(t *testing.T) {
	t.Parallel()
	s, _ := tasksServer(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "A"})
	mustBlock(t, s, tk.ID, "pr", "o/r#1")

	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	var calls atomic.Int32
	s.blockerLookupFor = func() tasks.StatusLookup {
		if calls.Add(1) > 1 { // the second pass, the poll's: the PR has merged
			return func(string, string) (tasks.ResourceStatus, bool) {
				return tasks.ResourceStatus{Done: true, Label: "merged"}, true
			}
		}
		// The web write: it read "open" just before the merge landed.
		return func(string, string) (tasks.ResourceStatus, bool) {
			once.Do(func() { close(entered) })
			<-release
			return tasks.ResourceStatus{Done: false, Label: "open"}, true
		}
	}

	webDone, pollDone := make(chan struct{}), make(chan struct{})
	go func() { s.afterTaskWrite(); close(webDone) }()
	<-entered
	go func() { s.resolvePass(tasks.ResolveOptions{}); close(pollDone) }()
	select {
	case <-pollDone: // without the mutex, the poll commits here
	case <-time.After(300 * time.Millisecond): // with it, the poll waits
	}
	close(release)
	<-webDone
	<-pollDone

	if bl := blockerOf(t, s, tk.ID); bl.ResolvedAt == "" || bl.ResolvedReason != "merged" {
		t.Fatalf("blocker = %+v, want resolved \"merged\"", bl)
	}
	var unresolves int
	must(t, s.DB.QueryRow(`SELECT COUNT(*) FROM task_events WHERE type = ?`, tasks.EventTaskBlockerUnresolved).Scan(&unresolves))
	if unresolves != 0 {
		t.Fatalf("%d unresolve events: a stale pass undid the poll's resolution", unresolves)
	}
}
