package webui

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	watcherdb "github.com/mturley/watcher/db"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/tasks"
)

// fakeJira is the blocker lookup's Jira seam: it records every search.
type fakeJira struct {
	mu      sync.Mutex
	issues  map[string]wjira.IssueSummary
	err     error
	queries []string
}

func (f *fakeJira) SearchSummaries(jql string, max int) ([]wjira.IssueSummary, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.queries = append(f.queries, jql)
	if f.err != nil {
		return nil, false, f.err
	}
	var out []wjira.IssueSummary
	for k, is := range f.issues {
		if strings.Contains(jql, k) {
			out = append(out, is)
		}
	}
	return out, false, nil
}

// withJira installs f as the server's Jira searcher, counting how often the
// seam is asked for one.
func withJira(s *Server, f *fakeJira) *int {
	n := 0
	s.blockerJira = func() (jiraSearcher, bool) {
		n++
		return f, true
	}
	return &n
}

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
	s, _ := tasksServer(t)
	l := s.blockerStatusLookup()
	if _, ok := l("pr", "o/r#1"); ok {
		t.Fatal("never-polled PR is known")
	}
	for state, want := range map[string]tasks.ResourceStatus{
		"MERGED": {Done: true, Label: "merged"},
		"CLOSED": {Done: true, Label: "closed"},
		"OPEN":   {Done: false, Label: "open"},
	} {
		setPRState(t, s, "o/r#1", state)
		if got, ok := s.blockerStatusLookup()("pr", "o/r#1"); !ok || got != want {
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
	s, _ := tasksServer(t)
	var got []tasks.Resolution
	s.onResolutions = func(rs []tasks.Resolution) { got = append(got, rs...) }
	tk := mustTask(t, s, tasks.NewTask{Title: "A"})
	b := mustBlock(t, s, tk.ID, "pr", "o/r#4498")

	setPRState(t, s, "o/r#4498", "MERGED")
	s.afterTaskWrite()
	if bl := blockerOf(t, s, tk.ID); bl.ResolvedAt == "" || bl.ResolvedReason != "merged" {
		t.Fatalf("after merge, blocker = %+v", bl)
	}
	if len(got) != 1 || got[0].BlockerID != b.ID || !got[0].Resolved || got[0].Reason != "merged" {
		t.Fatalf("resolutions handed on = %+v", got)
	}

	setPRState(t, s, "o/r#4498", "OPEN")
	s.afterTaskWrite()
	if bl := blockerOf(t, s, tk.ID); bl.ResolvedAt != "" {
		t.Fatalf("after reopen, blocker = %+v", bl)
	}
	if len(got) != 2 || got[1].Resolved {
		t.Fatalf("resolutions handed on = %+v", got)
	}
}

func TestJiraBlockerLookupDisabledNeverBuildsClient(t *testing.T) {
	s, _ := tasksServer(t)
	f := &fakeJira{issues: map[string]wjira.IssueSummary{"ABC-1": {Key: "ABC-1", Status: "Done", StatusCategory: "done"}}}
	built := withJira(s, f)
	tk := mustTask(t, s, tasks.NewTask{Title: "A"})
	mustBlock(t, s, tk.ID, "jira", "ABC-1")
	s.SetWatchersDisabled(map[string]bool{config.ServiceJira: true})

	if _, ok := s.blockerStatusLookup()("jira", "ABC-1"); ok {
		t.Fatal("lookup known while the Jira watcher is off")
	}
	s.afterTaskWrite()
	if *built != 0 || len(f.queries) != 0 {
		t.Fatalf("Jira contacted while disabled: built %d, queries %v", *built, f.queries)
	}
	if bl := blockerOf(t, s, tk.ID); bl.ResolvedAt != "" {
		t.Fatalf("blocker changed while Jira is off: %+v", bl)
	}
}

func TestJiraBlockerDoneResolvesWithOneSearchPerPass(t *testing.T) {
	s, _ := tasksServer(t)
	f := &fakeJira{issues: map[string]wjira.IssueSummary{
		"ABC-1": {Key: "ABC-1", Status: "Done", StatusCategory: "done"},
		"ABC-2": {Key: "ABC-2", Status: "In Progress", StatusCategory: "indeterminate"},
	}}
	withJira(s, f)
	a, b := mustTask(t, s, tasks.NewTask{Title: "A"}), mustTask(t, s, tasks.NewTask{Title: "B"})
	mustBlock(t, s, a.ID, "jira", "ABC-1")
	mustBlock(t, s, b.ID, "jira", "abc-2") // case-insensitive key
	mustBlock(t, s, b.ID, "jira", "not a key")

	s.afterTaskWrite()
	if len(f.queries) != 1 {
		t.Fatalf("searches = %v, want exactly one", f.queries)
	}
	if bl := blockerOf(t, s, a.ID); bl.ResolvedAt == "" || bl.ResolvedReason != "Done" {
		t.Fatalf("ABC-1 blocker = %+v, want resolved \"Done\"", bl)
	}
	bs, _ := tasks.Blockers(s.DB, b.ID)
	for _, bl := range bs {
		if bl.ResolvedAt != "" {
			t.Fatalf("B blocker resolved: %+v", bl)
		}
	}
	if st, ok := s.blockerStatusLookup()("jira", "ABC-2"); !ok || st.Done || st.Label != "In Progress" {
		t.Fatalf("ABC-2 status = %+v, %v", st, ok)
	}
}

func TestJiraBlockerSearchErrorIsUnknown(t *testing.T) {
	s, _ := tasksServer(t)
	f := &fakeJira{err: errors.New("boom")}
	withJira(s, f)
	tk := mustTask(t, s, tasks.NewTask{Title: "A"})
	mustBlock(t, s, tk.ID, "jira", "ABC-1")
	if _, ok := s.blockerStatusLookup()("jira", "ABC-1"); ok {
		t.Fatal("lookup known after a failed search")
	}
}

func TestTaskWriteUnblocksThroughSink(t *testing.T) {
	s, _ := tasksServer(t)
	var got []tasks.Resolution
	s.onResolutions = func(rs []tasks.Resolution) { got = append(got, rs...) }
	s.initTaskHooks()
	t.Cleanup(func() { tasks.SetResolutionSink(s.DB, nil) })
	a, b := mustTask(t, s, tasks.NewTask{Title: "A"}), mustTask(t, s, tasks.NewTask{Title: "B"})
	if _, err := tasks.AddBlocker(s.DB, webUser, a.ID, tasks.BlockerTarget{Kind: tasks.BlockerTask, BlockingTaskID: b.ID}); err != nil {
		t.Fatal(err)
	}

	rec := serveTasks(t, s, "POST", "/api/tasks/state", map[string]any{"id": b.ID, "state": "done"})
	if rec.Code != 200 {
		t.Fatalf("state: %d %s", rec.Code, rec.Body)
	}
	if len(got) != 1 || !got[0].Resolved || got[0].Reason != "done" {
		t.Fatalf("resolutions = %+v", got)
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
