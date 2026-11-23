package webui

import (
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/tasks"
	"github.com/mturley/worktree/internal/testgit"
)

type searchFix struct {
	conn   *sql.DB
	srv    *Server
	a, b   string
	taskID int64
}

func newSearchFix(t *testing.T) *searchFix {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	f := &searchFix{conn: conn, srv: &Server{DB: conn}, a: testgit.Worktree(t), b: testgit.Worktree(t)}
	must(t, registry.Register(conn, registry.Entry{Path: f.a, Repo: "odh", RepoRoot: f.a, Branch: "alpha", CreatedAt: "2026-08-13T00:00:00Z"}))
	must(t, registry.Register(conn, registry.Entry{Path: f.b, Repo: "odh", RepoRoot: f.b, Branch: "beta", CreatedAt: "2026-08-13T00:00:00Z"}))

	must(t, resources.Add(conn, f.a, resources.Resource{Type: "slack", ID: "C1:1.1", URL: "su"}))
	must(t, watcherdb.UpsertResourceState(conn, "slack", "C1:1.1", `{"title":"inferencepool rollout","channel_name":"dash"}`, "2026-02-01T00:00:00Z", "x"))
	must(t, resources.Add(conn, f.a, resources.Resource{Type: "pr", ID: "o/r#1", URL: "pu"}))
	must(t, watcherdb.UpsertResourceState(conn, "pr", "o/r#1", `{"title":"Add inferencepool PR","state":"OPEN"}`, "2026-02-01T00:00:00Z", "x"))
	must(t, resources.Add(conn, f.b, resources.Resource{Type: "jira", ID: "PROJ-7", URL: "ju"}))
	must(t, watcherdb.UpsertResourceState(conn, "jira", "PROJ-7", `{"summary":"Other issue"}`, "2026-02-01T00:00:00Z", "x"))
	// An archived PR: followed once, then unfollowed.
	must(t, resources.Add(conn, f.b, resources.Resource{Type: "pr", ID: "o/r#9", URL: "p9"}))
	must(t, watcherdb.UpsertResourceState(conn, "pr", "o/r#9", `{"title":"Old inferencepool PR","state":"MERGED"}`, "2026-02-01T00:00:00Z", "x"))
	must(t, resources.Remove(conn, f.b, "pr", "o/r#9"))

	insertEvent(t, conn, "e1", "2026-09-01T00:00:02Z", "slack", "slack_thread_root", "Thread started by Alice: inferencepool is slow", "slack", "C1:1.1", "su")
	insertEvent(t, conn, "e2", "2026-09-01T00:00:01Z", "slack", "slack_reply", "Reply from Bob", "slack", "C1:1.1", "su")
	insertEvent(t, conn, "e3", "2026-09-01T00:00:00Z", "github", "pr_comment", "Comment on PR", "pr", "o/r#1", "pu")
	if _, err := conn.Exec(`UPDATE watcher_events SET body = 'secret body text' WHERE id = 'e1'`); err != nil {
		t.Fatal(err)
	}
	tk, err := tasks.Create(conn, tasks.Actor{Kind: tasks.ActorUser}, tasks.NewTask{Title: "Tune inferencepool sizing"})
	if err != nil {
		t.Fatal(err)
	}
	f.taskID = tk.ID
	return f
}

func hasRes(rs []SearchResourceHit, id string) bool {
	for _, r := range rs {
		if r.ID == id {
			return true
		}
	}
	return false
}

func TestSearchEmptyQuery(t *testing.T) {
	t.Parallel()
	f := newSearchFix(t)
	if _, err := f.srv.Search(SearchQuery{Query: "   "}); !errors.Is(err, ErrEmptyQuery) {
		t.Fatalf("err = %v", err)
	}
}

func TestSearchGroupsGlobal(t *testing.T) {
	t.Parallel()
	f := newSearchFix(t)
	got, err := f.srv.Search(SearchQuery{Query: "inferencepool"})
	if err != nil {
		t.Fatal(err)
	}
	if !hasRes(got.Resources, "C1:1.1") || !hasRes(got.Resources, "o/r#1") {
		t.Errorf("resources = %+v", got.Resources)
	}
	if hasRes(got.Resources, "o/r#9") {
		t.Errorf("archived resource leaked: %+v", got.Resources)
	}
	var wtA *SearchWorktreeHit
	for i := range got.Worktrees {
		if got.Worktrees[i].Path == f.a {
			wtA = &got.Worktrees[i]
		}
		if got.Worktrees[i].Path == f.b {
			t.Errorf("beta follows nothing matching: %+v", got.Worktrees[i])
		}
	}
	if wtA == nil || wtA.Match == nil || wtA.Match.Field != "resource" {
		t.Errorf("worktree via resource = %+v", wtA)
	}
	if len(got.Tasks) != 1 || got.Tasks[0].ID != f.taskID {
		t.Errorf("tasks = %+v", got.Tasks)
	}
	var root *SearchEventHit
	for i := range got.Events {
		if got.Events[i].ID == "e1" {
			root = &got.Events[i]
		}
	}
	if root == nil || root.Type != "slack_thread_root" {
		t.Fatalf("events = %+v", got.Events)
	}
	raw, err := json.Marshal(got.Events[0])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"body"`) || strings.Contains(string(raw), "secret body") {
		t.Errorf("event JSON carries a body: %s", raw)
	}
}

func TestSearchScoped(t *testing.T) {
	t.Parallel()
	f := newSearchFix(t)
	got, err := f.srv.Search(SearchQuery{Query: "inferencepool", WorktreePath: f.b, Archived: true})
	if err != nil {
		t.Fatal(err)
	}
	if got.Worktrees != nil || got.Tasks != nil {
		t.Errorf("scoped: worktrees=%v tasks=%v", got.Worktrees, got.Tasks)
	}
	if len(got.Resources) != 0 || len(got.Events) != 0 {
		t.Errorf("beta has nothing matching: %+v", got)
	}
	got, err = f.srv.Search(SearchQuery{Query: "inferencepool", WorktreePath: f.a})
	if err != nil {
		t.Fatal(err)
	}
	if !hasRes(got.Resources, "C1:1.1") || !hasRes(got.Resources, "o/r#1") || len(got.Resources) != 2 {
		t.Errorf("alpha resources = %+v", got.Resources)
	}
	if len(got.Events) == 0 {
		t.Error("alpha should have events")
	}
}

func TestSearchSourcesAndUnread(t *testing.T) {
	t.Parallel()
	f := newSearchFix(t)
	got, err := f.srv.Search(SearchQuery{Query: "inferencepool", Sources: []string{"slack"}})
	if err != nil {
		t.Fatal(err)
	}
	if hasRes(got.Resources, "o/r#1") || !hasRes(got.Resources, "C1:1.1") || got.Tasks != nil {
		t.Errorf("slack only: %+v", got)
	}
	for _, e := range got.Events {
		if e.Resource.Type != "slack" {
			t.Errorf("non-slack event %+v", e)
		}
	}
	got, err = f.srv.Search(SearchQuery{Query: "inferencepool", Sources: []string{"task"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Resources) != 0 || len(got.Tasks) != 1 {
		t.Errorf("task only: %+v", got)
	}
	for _, e := range got.Events {
		if e.Resource.Type != "task" {
			t.Errorf("non-task event %+v", e)
		}
	}
	got, err = f.srv.Search(SearchQuery{Query: "inferencepool", UnreadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if got.Tasks != nil {
		t.Errorf("unread must drop tasks: %+v", got.Tasks)
	}
	// resources.Add seeds each cursor at now: e3 (2026) is read, while e5,
	// dated 2099, is past o/r#5's cursor and so unread.
	must(t, resources.Add(f.conn, f.b, resources.Resource{Type: "pr", ID: "o/r#5", URL: "p5"}))
	must(t, watcherdb.UpsertResourceState(f.conn, "pr", "o/r#5", `{"title":"Fresh inferencepool PR","state":"OPEN"}`, "2026-02-01T00:00:00Z", "x"))
	insertEvent(t, f.conn, "e5", "2099-01-01T00:00:00Z", "github", "pr_comment", "Fresh comment", "pr", "o/r#5", "p5")
	all, err := f.srv.Search(SearchQuery{Query: "inferencepool"})
	if err != nil {
		t.Fatal(err)
	}
	if !hasRes(all.Resources, "o/r#1") || !hasRes(all.Resources, "o/r#5") {
		t.Fatalf("setup: %+v", all.Resources)
	}
	got, err = f.srv.Search(SearchQuery{Query: "inferencepool", UnreadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if hasRes(got.Resources, "o/r#1") || !hasRes(got.Resources, "o/r#5") {
		t.Errorf("unread resources = %+v", got.Resources)
	}
	var ids []string
	for _, e := range got.Events {
		ids = append(ids, e.ID)
	}
	if !containsString(ids, "e5") || containsString(ids, "e3") {
		t.Errorf("unread events = %v", ids)
	}
}

func TestSearchArchived(t *testing.T) {
	t.Parallel()
	f := newSearchFix(t)
	got, err := f.srv.Search(SearchQuery{Query: "inferencepool", Archived: true})
	if err != nil {
		t.Fatal(err)
	}
	var arch *SearchResourceHit
	for i := range got.Resources {
		if got.Resources[i].ID == "o/r#9" {
			arch = &got.Resources[i]
		}
	}
	if arch == nil || !arch.Archived || len(arch.LastFollowedBy) != 1 || arch.LastFollowedBy[0] != f.b {
		t.Errorf("archived hit = %+v", arch)
	}
	for _, r := range got.Resources {
		if r.ID != "o/r#9" && r.Archived {
			t.Errorf("live resource marked archived: %+v", r)
		}
	}
}

func TestSearchTasksIncludeDone(t *testing.T) {
	t.Parallel()
	f := newSearchFix(t)
	// The done task is created FIRST, so a stable sort would list it first
	// unless the done-after-open rule pushes it back.
	done, err := tasks.Create(f.conn, tasks.Actor{Kind: tasks.ActorUser}, tasks.NewTask{Title: "Tune inferencepool docs"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tasks.SetState(f.conn, tasks.Actor{Kind: tasks.ActorUser}, done.ID, tasks.StateDone); err != nil {
		t.Fatal(err)
	}
	open, err := tasks.Create(f.conn, tasks.Actor{Kind: tasks.ActorUser}, tasks.NewTask{Title: "Tune inferencepool sizing again"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := f.srv.Search(SearchQuery{Query: "tune inferencepool"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Tasks) != 3 {
		t.Fatalf("tasks = %+v", got.Tasks)
	}
	if last := got.Tasks[2]; last.ID != done.ID || last.State != "done" {
		t.Errorf("done task must rank after the open ones: %+v", got.Tasks)
	}
	_ = open
}

func TestSearchLiteralWildcards(t *testing.T) {
	t.Parallel()
	f := newSearchFix(t)
	for _, c := range []struct{ id, title string }{{"o/r#20", "100% done"}, {"o/r#21", "1000 done"}, {"o/r#22", "a_b thing"}, {"o/r#23", "axb thing"}} {
		must(t, resources.Add(f.conn, f.a, resources.Resource{Type: "pr", ID: c.id, URL: "u"}))
		must(t, watcherdb.UpsertResourceState(f.conn, "pr", c.id, `{"title":"`+c.title+`"}`, "2026-02-01T00:00:00Z", "x"))
		insertEvent(t, f.conn, "w"+c.id, "2026-09-02T00:00:00Z", "github", "pr_comment", c.title, "pr", c.id, "u")
	}
	check := func(q string, want string, notWant string) {
		got, err := f.srv.Search(SearchQuery{Query: q})
		if err != nil {
			t.Fatal(err)
		}
		if !hasRes(got.Resources, want) || hasRes(got.Resources, notWant) {
			t.Errorf("%q resources = %+v", q, got.Resources)
		}
		var sawWant bool
		for _, e := range got.Events {
			if e.Resource.ID == notWant {
				t.Errorf("%q matched event of %s", q, notWant)
			}
			if e.Resource.ID == want {
				sawWant = true
			}
		}
		if !sawWant {
			t.Errorf("%q: no event for %s", q, want)
		}
	}
	check("100%", "o/r#20", "o/r#21")
	check("a_b", "o/r#22", "o/r#23")
}
