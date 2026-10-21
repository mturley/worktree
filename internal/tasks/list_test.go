package tasks

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"

	watcher "github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
)

// mkWorktree makes a real directory, registers it, and returns its path.
func mkWorktree(t *testing.T, conn *sql.DB, name string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.Mkdir(p, 0o755); err != nil {
		t.Fatal(err)
	}
	register(t, conn, p)
	return p
}

func res(lt LinkTarget) watcher.Resource {
	return watcher.Resource{Type: lt.ResourceType, ID: lt.ResourceID}
}

func subscribe(t *testing.T, conn *sql.DB, path string, lt LinkTarget) {
	t.Helper()
	if err := watcherdb.Subscribe(conn, wdb.Subscriber(path), res(lt), watcherdb.SubscribeOpts{}); err != nil {
		t.Fatal(err)
	}
}

func unsubscribe(t *testing.T, conn *sql.DB, path string, lt LinkTarget) {
	t.Helper()
	if err := watcherdb.Unsubscribe(conn, wdb.Subscriber(path), res(lt)); err != nil {
		t.Fatal(err)
	}
}

func mustList(t *testing.T, conn *sql.DB, f Filter) []Task {
	t.Helper()
	ts, err := List(conn, f)
	if err != nil {
		t.Fatal(err)
	}
	return ts
}

func ids(ts []Task) []int64 {
	out := []int64{}
	for _, tk := range ts {
		out = append(out, tk.ID)
	}
	return out
}

func sameIDs(got []Task, want ...int64) bool {
	g := ids(got)
	if len(g) != len(want) {
		return false
	}
	for i := range g {
		if g[i] != want[i] {
			return false
		}
	}
	return true
}

func wtScope(p string) Filter { return Filter{Scope: Scope{Kind: ScopeWorktree, Worktree: p}} }

func TestListImplicitMembership(t *testing.T) {
	conn := newDB(t)
	x := mkWorktree(t, conn, "x")
	y := mkWorktree(t, conn, "y")
	z := mkWorktree(t, conn, "z")
	subscribe(t, conn, x, prLink)
	subscribe(t, conn, y, prLink)
	tk, err := Create(conn, user, NewTask{Title: "x", Focus: []LinkTarget{prLink}})
	if err != nil {
		t.Fatal(err)
	}
	other := mustCreate(t, conn, "unlinked")
	for _, w := range []string{x, y} {
		if got := mustList(t, conn, wtScope(w)); !sameIDs(got, tk.ID) {
			t.Fatalf("List(worktree %s) = %v", w, ids(got))
		}
	}
	if got := mustList(t, conn, wtScope(z)); len(got) != 0 {
		t.Fatalf("List(worktree z) = %v", ids(got))
	}
	got := mustGet(t, conn, tk.ID)
	wantX, wantY := canon(x), canon(y)
	if wantY < wantX {
		wantX, wantY = wantY, wantX
	}
	if len(got.Implicit) != 2 || got.Implicit[0] != wantX || got.Implicit[1] != wantY {
		t.Fatalf("Implicit = %v", got.Implicit)
	}
	if got.Archived || got.Links[0].Archived {
		t.Fatalf("archived: %+v", got)
	}
	// A global task (no links) is in the all scope only, and never archived.
	all := mustList(t, conn, Filter{})
	if !sameIDs(all, tk.ID, other.ID) || all[1].Archived {
		t.Fatalf("List(all) = %+v", all)
	}
}

func TestListResourceScope(t *testing.T) {
	conn := newDB(t)
	a, err := Create(conn, user, NewTask{Title: "a", Focus: []LinkTarget{prLink}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := Create(conn, user, NewTask{Title: "b", Focus: []LinkTarget{jiraLink}})
	if err != nil {
		t.Fatal(err)
	}
	mustAddLink(t, conn, b.ID, prLink, false)
	mustCreate(t, conn, "c")
	got := mustList(t, conn, Filter{Scope: Scope{Kind: ScopeResource, ResourceType: "pr", ResourceID: "o/r#1"}})
	if !sameIDs(got, a.ID, b.ID) {
		t.Fatalf("List(resource pr) = %v", ids(got))
	}
	got = mustList(t, conn, Filter{Scope: Scope{Kind: ScopeResource, ResourceType: "jira", ResourceID: "ABC-1"}})
	if !sameIDs(got, b.ID) {
		t.Fatalf("List(resource jira) = %v", ids(got))
	}
}

func TestListArchivedFallback(t *testing.T) {
	conn := newDB(t)
	x := mkWorktree(t, conn, "x")
	y := mkWorktree(t, conn, "y")
	subscribe(t, conn, x, prLink)
	unsubscribe(t, conn, x, prLink)
	tk, err := Create(conn, user, NewTask{Title: "x", Focus: []LinkTarget{prLink}})
	if err != nil {
		t.Fatal(err)
	}
	got := mustGet(t, conn, tk.ID)
	if !got.Archived || !got.Links[0].Archived || len(got.Implicit) != 0 {
		t.Fatalf("task %+v", got)
	}
	if l := mustList(t, conn, wtScope(x)); !sameIDs(l, tk.ID) {
		t.Fatalf("List(worktree x) = %v", ids(l))
	}
	if l := mustList(t, conn, wtScope(y)); len(l) != 0 {
		t.Fatalf("List(worktree y) = %v", ids(l))
	}
	if l := mustList(t, conn, Filter{}); !sameIDs(l, tk.ID) {
		t.Fatalf("List(all) = %v", ids(l))
	}
	if err := registry.Unregister(conn, x); err != nil {
		t.Fatal(err)
	}
	if l := mustList(t, conn, wtScope(x)); len(l) != 0 {
		t.Fatalf("List(worktree x) after unregister = %v", ids(l))
	}
	l := mustList(t, conn, Filter{})
	if !sameIDs(l, tk.ID) || !l[0].Archived {
		t.Fatalf("List(all) after unregister = %+v", l)
	}
}

func TestListFallbackNeedsEveryLinkArchived(t *testing.T) {
	conn := newDB(t)
	x := mkWorktree(t, conn, "x")
	y := mkWorktree(t, conn, "y")
	subscribe(t, conn, x, prLink)
	unsubscribe(t, conn, x, prLink)
	subscribe(t, conn, y, jiraLink)
	tk, err := Create(conn, user, NewTask{Title: "x", Focus: []LinkTarget{prLink, jiraLink}})
	if err != nil {
		t.Fatal(err)
	}
	got := mustGet(t, conn, tk.ID)
	if got.Archived || !got.Links[0].Archived || got.Links[1].Archived {
		t.Fatalf("task %+v", got)
	}
	// Not archived, so the tombstone in x does not pull it in.
	if l := mustList(t, conn, wtScope(x)); len(l) != 0 {
		t.Fatalf("List(worktree x) = %v", ids(l))
	}
	if l := mustList(t, conn, wtScope(y)); !sameIDs(l, tk.ID) {
		t.Fatalf("List(worktree y) = %v", ids(l))
	}
}

func TestListWorktreeLinkArchived(t *testing.T) {
	conn := newDB(t)
	x := mkWorktree(t, conn, "x")
	tk, err := Create(conn, user, NewTask{Title: "x", Focus: []LinkTarget{{Kind: LinkWorktree, Worktree: x}}})
	if err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, conn, tk.ID); got.Archived {
		t.Fatalf("archived while registered: %+v", got)
	}
	if err := registry.Unregister(conn, x); err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, conn, tk.ID); !got.Archived || !got.Links[0].Archived {
		t.Fatalf("not archived after unregister: %+v", got)
	}
}

func TestListCompletedArchivedHidden(t *testing.T) {
	conn := newDB(t)
	x := mkWorktree(t, conn, "x")
	subscribe(t, conn, x, jiraLink)
	archived, err := Create(conn, user, NewTask{Title: "archived", Focus: []LinkTarget{prLink}})
	if err != nil {
		t.Fatal(err)
	}
	live, err := Create(conn, user, NewTask{Title: "live", Focus: []LinkTarget{jiraLink}})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{archived.ID, live.ID} {
		if _, err := SetState(conn, user, id, StateDone); err != nil {
			t.Fatal(err)
		}
	}
	if l := mustList(t, conn, Filter{}); len(l) != 0 {
		t.Fatalf("List(all) = %v", ids(l))
	}
	if l := mustList(t, conn, Filter{IncludeCompleted: true}); !sameIDs(l, live.ID) {
		t.Fatalf("List(all, completed) = %v", ids(l))
	}
	if l := mustList(t, conn, Filter{IncludeCompleted: true, IncludeArchived: true}); !sameIDs(l, archived.ID, live.ID) {
		t.Fatalf("List(all, completed+archived) = %v", ids(l))
	}
	// IncludeArchived alone shows no completed task.
	if l := mustList(t, conn, Filter{IncludeArchived: true}); len(l) != 0 {
		t.Fatalf("List(all, archived only) = %v", ids(l))
	}
	// Get always returns it.
	if got := mustGet(t, conn, archived.ID); !got.Archived {
		t.Fatalf("Get %+v", got)
	}
}

func TestListIgnoresNonWorktreeSubscribers(t *testing.T) {
	conn := newDB(t)
	if err := watcherdb.Subscribe(conn, "task:7", res(prLink), watcherdb.SubscribeOpts{}); err != nil {
		t.Fatal(err)
	}
	tk, err := Create(conn, user, NewTask{Title: "x", Focus: []LinkTarget{prLink}})
	if err != nil {
		t.Fatal(err)
	}
	got := mustGet(t, conn, tk.ID)
	if !got.Links[0].Archived || !got.Archived || len(got.Implicit) != 0 {
		t.Fatalf("task %+v", got)
	}
}

func TestListFiltersAndOrder(t *testing.T) {
	conn := newDB(t)
	a, _ := Create(conn, user, NewTask{Title: "a", Priority: PriorityHigh})
	b, _ := Create(conn, user, NewTask{Title: "b", Priority: PriorityLow, Starred: true})
	c, _ := Create(conn, user, NewTask{Title: "c", Priority: PriorityHigh, Starred: true})
	if err := MoveToTop(conn, c.ID); err != nil {
		t.Fatal(err)
	}
	if l := mustList(t, conn, Filter{}); !sameIDs(l, c.ID, a.ID, b.ID) {
		t.Fatalf("order = %v", ids(l))
	}
	if l := mustList(t, conn, Filter{Priorities: []Priority{PriorityHigh}}); !sameIDs(l, c.ID, a.ID) {
		t.Fatalf("high = %v", ids(l))
	}
	if l := mustList(t, conn, Filter{StarredOnly: true}); !sameIDs(l, c.ID, b.ID) {
		t.Fatalf("starred = %v", ids(l))
	}
	if l := mustList(t, conn, Filter{StarredOnly: true, Priorities: []Priority{PriorityLow, PriorityNone}}); !sameIDs(l, b.ID) {
		t.Fatalf("starred+low = %v", ids(l))
	}
	if _, err := Delete(conn, user, a.ID); err != nil {
		t.Fatal(err)
	}
	if l := mustList(t, conn, Filter{}); !sameIDs(l, c.ID, b.ID) {
		t.Fatalf("after delete = %v", ids(l))
	}
}

func TestListRejectsBadScope(t *testing.T) {
	conn := newDB(t)
	bad := []Filter{
		{Scope: Scope{Kind: "nope"}},
		{Scope: Scope{Kind: ScopeWorktree}},
		{Scope: Scope{Kind: ScopeResource, ResourceType: "pr"}},
	}
	for _, f := range bad {
		if _, err := List(conn, f); err == nil {
			t.Errorf("List(%+v) succeeded", f)
		}
	}
}

func TestListRejectsUnknownPriorityAndState(t *testing.T) {
	conn := newDB(t)
	mustCreate(t, conn, "t")
	for _, f := range []Filter{
		{Priorities: []Priority{"hgh"}},
		{Priorities: []Priority{PriorityHigh, ""}},
		{States: []State{"finished"}},
	} {
		if _, err := List(conn, f); !errors.Is(err, ErrInvalid) {
			t.Errorf("List(%+v) err = %v, want ErrInvalid", f, err)
		}
	}
}

func TestListStateFilter(t *testing.T) {
	conn := newDB(t)
	a := mustCreate(t, conn, "a")
	b := mustCreate(t, conn, "b")
	c := mustCreate(t, conn, "c")
	if _, err := SetState(conn, user, b.ID, StateInProgress); err != nil {
		t.Fatal(err)
	}
	if _, err := SetState(conn, user, c.ID, StateDone); err != nil {
		t.Fatal(err)
	}
	if got := mustList(t, conn, Filter{States: []State{StateInProgress}}); !sameIDs(got, b.ID) {
		t.Errorf("in_progress = %v", ids(got))
	}
	if got := mustList(t, conn, Filter{States: []State{StateNotStarted, StateInProgress}}); !sameIDs(got, a.ID, b.ID) {
		t.Errorf("open states = %v", ids(got))
	}
	// The state filter narrows; it does not widen past IncludeCompleted.
	if got := mustList(t, conn, Filter{States: []State{StateDone}}); !sameIDs(got) {
		t.Errorf("done without completed = %v", ids(got))
	}
	if got := mustList(t, conn, Filter{States: []State{StateDone}, IncludeCompleted: true}); !sameIDs(got, c.ID) {
		t.Errorf("done = %v", ids(got))
	}
	if got := mustList(t, conn, Filter{IncludeCompleted: true}); !sameIDs(got, a.ID, b.ID, c.ID) {
		t.Errorf("no state filter = %v", ids(got))
	}
}

func TestListIgnoresExpiredLease(t *testing.T) {
	conn := newDB(t)
	x := mkWorktree(t, conn, "x")
	tk := mustCreate(t, conn, "t")
	if _, err := AddLink(conn, user, tk.ID, prLink, true); err != nil {
		t.Fatal(err)
	}
	subscribe(t, conn, x, prLink)
	if got := mustGet(t, conn, tk.ID); got.Archived || len(got.Implicit) != 1 {
		t.Fatalf("live lease: %+v", got)
	}
	setExpiry := func(ts string) {
		t.Helper()
		if _, err := conn.Exec(`UPDATE watcher_subscriptions SET expires_at = ? WHERE resource_id = ?`,
			ts, prLink.ResourceID); err != nil {
			t.Fatal(err)
		}
	}
	setExpiry("2000-01-01T00:00:00Z")
	got := mustGet(t, conn, tk.ID)
	if !got.Archived || len(got.Implicit) != 0 || !got.Links[0].Archived {
		t.Fatalf("expired lease still counts as following: %+v", got)
	}
	if ts := mustList(t, conn, wtScope(x)); len(ts) != 0 {
		t.Fatalf("expired lease still puts the task in x's scope: %v", ids(ts))
	}
	setExpiry("2999-01-01T00:00:00Z")
	if got := mustGet(t, conn, tk.ID); got.Archived || len(got.Implicit) != 1 {
		t.Fatalf("future lease: %+v", got)
	}
}
