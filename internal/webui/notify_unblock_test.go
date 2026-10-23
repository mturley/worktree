package webui

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/notifyprefs"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/tasks"
)

// unblockRig drives notifyPass with a fake clock, so the Unblocked hold
// window elapses without sleeping.
type unblockRig struct {
	s   *Server
	ft  *fakeTransport
	c   notifyCursor
	now time.Time
}

func newUnblockRig(t *testing.T, conn *sql.DB) *unblockRig {
	t.Helper()
	r := &unblockRig{ft: &fakeTransport{}, now: time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)}
	r.s = &Server{DB: conn, transport: r.ft, unblockHold: time.Minute, notifyNow: func() time.Time { return r.now }}
	r.c = readyCursor(t, conn)
	return r
}

func (r *unblockRig) pass() { r.s.notifyPass(&r.c) }

// settle runs a pass that finds new events, then one after the hold.
func (r *unblockRig) settle() {
	r.pass()
	r.now = r.now.Add(time.Minute)
	r.pass()
}

// orderedWorktrees returns two registered worktrees in registry order, so a
// test can expect the SECOND one and prove targeting is not just "first".
func orderedWorktrees(t *testing.T, conn *sql.DB) (first, second string) {
	t.Helper()
	twoWorktrees(t, conn)
	es, err := registry.List(conn)
	if err != nil || len(es) != 2 {
		t.Fatalf("registry: %v %+v", err, es)
	}
	return es[0].Path, es[1].Path
}

func mustAddBlocker(t *testing.T, conn *sql.DB, taskID int64, b tasks.BlockerTarget) tasks.Blocker {
	t.Helper()
	bl, err := tasks.AddBlocker(conn, userActor, taskID, b)
	if err != nil {
		t.Fatal(err)
	}
	return bl
}

func mustCreateTask(t *testing.T, conn *sql.DB, n tasks.NewTask) tasks.Task {
	t.Helper()
	tk, err := tasks.Create(conn, userActor, n)
	if err != nil {
		t.Fatal(err)
	}
	return tk
}

// blockOnTask makes waiter blocked by a new task "Fix the thing", returning
// the blocking task.
func blockOnTask(t *testing.T, conn *sql.DB, waiter int64) tasks.Task {
	t.Helper()
	dep := mustCreateTask(t, conn, tasks.NewTask{Title: "Fix the thing"})
	mustAddBlocker(t, conn, waiter, tasks.BlockerTarget{Kind: tasks.BlockerTask, BlockingTaskID: dep.ID})
	return dep
}

func mustDone(t *testing.T, conn *sql.DB, id int64) {
	t.Helper()
	if _, err := tasks.SetState(conn, userActor, id, tasks.StateDone); err != nil {
		t.Fatal(err)
	}
}

func prLookup(state map[string]tasks.ResourceStatus) tasks.StatusLookup {
	return func(typ, id string) (tasks.ResourceStatus, bool) {
		st, ok := state[typ+":"+id]
		return st, ok
	}
}

func TestUnblockNotifiesWithEveryToggleOff(t *testing.T) {
	conn := unreadTestDB(t)
	first, _ := orderedWorktrees(t, conn) // no toggle anywhere
	waiter := newLinkedTask(t, conn, userActor, "Ship it", "o/r#7")
	dep := blockOnTask(t, conn, waiter.ID)
	r := newUnblockRig(t, conn)

	mustDone(t, conn, dep.ID)
	r.pass()
	if len(r.ft.got) != 0 {
		t.Fatalf("delivered before the hold elapsed: %+v", r.ft.got)
	}
	r.now = r.now.Add(time.Minute)
	r.pass()
	r.pass() // never twice
	if len(r.ft.got) != 1 {
		t.Fatalf("delivered %d, want 1: %+v", len(r.ft.got), r.ft.got)
	}
	b := r.ft.got[0]
	id := strconv.FormatInt(waiter.ID, 10)
	want := fmt.Sprintf("Unblocked: T%d Fix the thing is done", dep.ID)
	if b.Title != "Ship it" || b.Body != want {
		t.Fatalf("title/body = %q / %q, want %q", b.Title, b.Body, want)
	}
	if b.WorktreePath != first || b.ResourceType != "task" || b.ResourceID != id || b.Subtitle != filepath.Base(first) {
		t.Fatalf("target = %+v", b)
	}
	if b.Event != b.Body || b.Resource != "T"+id+": Ship it" || b.Tag == "" {
		t.Fatalf("placeholders/tag = %+v", b)
	}
}

func TestUnblockBodies(t *testing.T) {
	conn := unreadTestDB(t)
	twoWorktrees(t, conn)
	pr := mustCreateTask(t, conn, tasks.NewTask{Title: "Wait on PR"})
	mustAddBlocker(t, conn, pr.ID, tasks.BlockerTarget{Kind: tasks.BlockerResource, ResourceType: "pr", ResourceID: "o/r#4498"})
	jira := mustCreateTask(t, conn, tasks.NewTask{Title: "Wait on Jira"})
	mustAddBlocker(t, conn, jira.ID, tasks.BlockerTarget{Kind: tasks.BlockerResource, ResourceType: "jira", ResourceID: "ABC-1"})
	gone := mustCreateTask(t, conn, tasks.NewTask{Title: "Wait on doomed"})
	doomed := blockOnTask(t, conn, gone.ID)
	r := newUnblockRig(t, conn)

	if _, err := tasks.ResolveBlockers(conn, prLookup(map[string]tasks.ResourceStatus{
		"pr:o/r#4498": {Done: true, Label: "merged"},
		"jira:ABC-1":  {Done: true, Label: "Closed"},
	})); err != nil {
		t.Fatal(err)
	}
	if _, err := tasks.Delete(conn, userActor, doomed.ID); err != nil {
		t.Fatal(err)
	}
	r.settle()
	got := map[string]string{}
	for _, b := range r.ft.got {
		got[b.Title] = b.Body
	}
	want := map[string]string{
		"Wait on PR":     "Unblocked: #4498 merged",
		"Wait on Jira":   "Unblocked: ABC-1 Closed",
		"Wait on doomed": fmt.Sprintf("Unblocked: T%d Fix the thing was deleted", doomed.ID),
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("bodies = %v, want %v", got, want)
	}
}

func TestUnblockGlobalSwitchOffSendsNothing(t *testing.T) {
	conn := unreadTestDB(t)
	a, _ := twoWorktrees(t, conn)
	notifyprefs.SetAll(conn, a, true)
	waiter := newLinkedTask(t, conn, userActor, "Ship it", "o/r#7")
	dep := blockOnTask(t, conn, waiter.ID)
	r := newUnblockRig(t, conn)
	r.s.notifyOff.Store(true)

	mustDone(t, conn, dep.ID)
	r.settle()
	if len(r.ft.got) != 0 {
		t.Fatalf("delivered with notifications off: %+v", r.ft.got)
	}
}

func TestUnblockTargeting(t *testing.T) {
	cases := []struct {
		name string
		// task builds the waiting task; it returns which worktree the
		// notification should target ("" = untargeted).
		task func(t *testing.T, conn *sql.DB, first, second string) (tasks.Task, string)
	}{
		{"focus worktree link", func(t *testing.T, conn *sql.DB, first, second string) (tasks.Task, string) {
			tk := mustCreateTask(t, conn, tasks.NewTask{Title: "W", Focus: []tasks.LinkTarget{{Kind: tasks.LinkWorktree, Worktree: second}}})
			// A Related link to first puts first in scope too; Focus wins.
			if _, err := tasks.AddLink(conn, userActor, tk.ID, tasks.LinkTarget{Kind: tasks.LinkWorktree, Worktree: first}, false); err != nil {
				t.Fatal(err)
			}
			return tk, second
		}},
		{"focus resource some worktree follows", func(t *testing.T, conn *sql.DB, first, second string) (tasks.Task, string) {
			if err := resources.Add(conn, second, resources.Resource{Type: "pr", ID: "o/r#9", URL: "u"}); err != nil {
				t.Fatal(err)
			}
			return mustCreateTask(t, conn, tasks.NewTask{Title: "W", Focus: []tasks.LinkTarget{
				{Kind: tasks.LinkResource, ResourceType: "pr", ResourceID: "o/r#9"},
			}}), second
		}},
		{"focus resource nobody follows falls back to scope", func(t *testing.T, conn *sql.DB, first, second string) (tasks.Task, string) {
			tk := mustCreateTask(t, conn, tasks.NewTask{Title: "W", Focus: []tasks.LinkTarget{
				{Kind: tasks.LinkResource, ResourceType: "pr", ResourceID: "o/r#404"},
			}})
			if _, err := tasks.AddLink(conn, userActor, tk.ID, tasks.LinkTarget{Kind: tasks.LinkWorktree, Worktree: second}, false); err != nil {
				t.Fatal(err)
			}
			return tk, second
		}},
		{"global task is untargeted", func(t *testing.T, conn *sql.DB, first, second string) (tasks.Task, string) {
			return mustCreateTask(t, conn, tasks.NewTask{Title: "W"}), ""
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			conn := unreadTestDB(t)
			first, second := orderedWorktrees(t, conn)
			tk, want := c.task(t, conn, first, second)
			dep := blockOnTask(t, conn, tk.ID)
			r := newUnblockRig(t, conn)
			mustDone(t, conn, dep.ID)
			r.settle()
			if len(r.ft.got) != 1 {
				t.Fatalf("delivered %+v, want 1", r.ft.got)
			}
			b := r.ft.got[0]
			if wdb.Subscriber(b.WorktreePath) != wdb.Subscriber(want) && !(want == "" && b.WorktreePath == "") {
				t.Fatalf("target = %q, want %q", b.WorktreePath, want)
			}
			if b.ResourceType != "task" || b.ResourceID != strconv.FormatInt(tk.ID, 10) {
				t.Fatalf("resource = %s:%s", b.ResourceType, b.ResourceID)
			}
			if want == "" && b.Subtitle != "" {
				t.Fatalf("untargeted subtitle = %q", b.Subtitle)
			}
		})
	}
}

func TestUnblockNeverNotifiesTwiceThroughTaskPath(t *testing.T) {
	conn := unreadTestDB(t)
	a, b := twoWorktrees(t, conn)
	notifyprefs.SetAll(conn, a, true)
	notifyprefs.SetResource(conn, b, "pr", "o/r#7", true)
	waiter := newLinkedTask(t, conn, userActor, "Ship it", "o/r#7") // in both scopes
	dep := blockOnTask(t, conn, waiter.ID)
	r := newUnblockRig(t, conn)

	mustDone(t, conn, dep.ID)
	r.settle()
	r.settle()
	if len(r.ft.got) != 1 || !strings.HasPrefix(r.ft.got[0].Body, "Unblocked: ") {
		t.Fatalf("delivered %+v, want exactly the one Unblocked notification", r.ft.got)
	}
}

func TestUnblockUnresolveDoesNotNotify(t *testing.T) {
	conn := unreadTestDB(t)
	a, _ := twoWorktrees(t, conn)
	notifyprefs.SetAll(conn, a, true)
	waiter := newLinkedTask(t, conn, userActor, "Ship it", "o/r#7")
	mustAddBlocker(t, conn, waiter.ID, tasks.BlockerTarget{Kind: tasks.BlockerResource, ResourceType: "pr", ResourceID: "o/r#4498"})
	r := newUnblockRig(t, conn)

	if _, err := tasks.ResolveBlockers(conn, prLookup(map[string]tasks.ResourceStatus{"pr:o/r#4498": {Done: true, Label: "merged"}})); err != nil {
		t.Fatal(err)
	}
	r.settle()
	if len(r.ft.got) != 1 {
		t.Fatalf("resolve delivered %+v, want 1", r.ft.got)
	}
	rs, err := tasks.ResolveBlockers(conn, prLookup(map[string]tasks.ResourceStatus{"pr:o/r#4498": {Done: false, Label: "open"}}))
	if err != nil || len(rs) != 1 || rs[0].Resolved {
		t.Fatalf("unresolve = %+v, %v", rs, err)
	}
	r.settle()
	if len(r.ft.got) != 1 {
		t.Fatalf("an unresolve notified: %+v", r.ft.got)
	}
}

func TestUnblockFromAnotherProcessNotifies(t *testing.T) {
	path := filepath.Join(t.TempDir(), "w.db")
	open := func() *sql.DB {
		conn, err := wdb.OpenAt(path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.Close() })
		return conn
	}
	ui, cli := open(), open() // the CLI is a separate process with its own connection
	twoWorktrees(t, ui)
	waiter := newLinkedTask(t, ui, userActor, "Ship it", "o/r#7")
	dep := blockOnTask(t, ui, waiter.ID)
	r := newUnblockRig(t, ui)

	mustDone(t, cli, dep.ID) // resolves inside the tasks package, on cli
	r.settle()
	if len(r.ft.got) != 1 || r.ft.got[0].Title != "Ship it" {
		t.Fatalf("delivered %+v, want the CLI's resolution", r.ft.got)
	}
}

func TestUnblockEventDeletedWithinHoldIsDropped(t *testing.T) {
	conn := unreadTestDB(t)
	twoWorktrees(t, conn)
	waiter := newLinkedTask(t, conn, userActor, "Ship it", "o/r#7")
	dep := blockOnTask(t, conn, waiter.ID)
	r := newUnblockRig(t, conn)

	mustDone(t, conn, dep.ID)
	r.pass() // found, held
	if _, err := conn.Exec(`DELETE FROM task_events WHERE type = ? AND actor = 'system'`, tasks.EventTaskBlockerResolved); err != nil {
		t.Fatal(err)
	}
	r.now = r.now.Add(time.Minute)
	r.pass()
	if len(r.ft.got) != 0 {
		t.Fatalf("an undone resolution notified: %+v", r.ft.got)
	}
}

func TestUnblockCountsTowardSummary(t *testing.T) {
	conn := unreadTestDB(t)
	twoWorktrees(t, conn)
	for i := 0; i <= notifyMaxPerPass; i++ {
		waiter := newLinkedTask(t, conn, userActor, fmt.Sprintf("Ship %d", i), "o/r#7")
		mustAddBlocker(t, conn, waiter.ID, tasks.BlockerTarget{Kind: tasks.BlockerResource, ResourceType: "pr", ResourceID: "o/r#4498"})
	}
	r := newUnblockRig(t, conn)
	if _, err := tasks.ResolveBlockers(conn, prLookup(map[string]tasks.ResourceStatus{"pr:o/r#4498": {Done: true, Label: "merged"}})); err != nil {
		t.Fatal(err)
	}
	r.settle()
	if len(r.ft.got) != 1 || r.ft.got[0].Title != "New activity" ||
		!strings.HasPrefix(r.ft.got[0].Body, strconv.Itoa(notifyMaxPerPass+1)+" tasks") {
		t.Fatalf("delivered %+v, want one summary", r.ft.got)
	}
}

// Adding a blocker that is already satisfied resolves it at once, and the
// user's own click is not news: no Unblocked notification. A later
// resolution of the same blocker still notifies.
func TestAddingSatisfiedBlockerDoesNotNotify(t *testing.T) {
	conn := unreadTestDB(t)
	twoWorktrees(t, conn)
	waiter := newLinkedTask(t, conn, userActor, "Ship it", "o/r#7")
	r := newUnblockRig(t, conn)
	must(t, watcherdb.UpsertResourceState(conn, "pr", "o/r#4498", `{"title":"T","state":"MERGED"}`, "2026-01-01T00:00:00Z", "x"))

	d := decodeDetail(t, serveTasks(t, r.s, "POST", "/api/tasks/blockers/add",
		map[string]any{"id": waiter.ID, "kind": "resource", "type": "pr", "rid": "o/r#4498"}))
	if len(d.Blockers) != 1 || !d.Blockers[0].Resolved {
		t.Fatalf("blockers = %+v, want resolved at once", d.Blockers)
	}
	r.settle()
	if len(r.ft.got) != 0 {
		t.Fatalf("adding a merged PR notified: %+v", r.ft.got)
	}

	// Reopened, then merged again: that one is news.
	must(t, watcherdb.UpsertResourceState(conn, "pr", "o/r#4498", `{"title":"T","state":"OPEN"}`, "2026-01-01T00:00:01Z", "x"))
	r.s.afterTaskWrite()
	must(t, watcherdb.UpsertResourceState(conn, "pr", "o/r#4498", `{"title":"T","state":"MERGED"}`, "2026-01-01T00:00:02Z", "x"))
	r.s.afterTaskWrite()
	r.settle()
	if len(r.ft.got) != 1 || !strings.HasPrefix(r.ft.got[0].Body, "Unblocked: ") {
		t.Fatalf("later resolution delivered %+v, want one Unblocked", r.ft.got)
	}
}

// The task-kind path: a blocking task already done resolves inside
// AddBlocker, with the same on_add mark.
func TestAddingDoneTaskBlockerDoesNotNotify(t *testing.T) {
	conn := unreadTestDB(t)
	twoWorktrees(t, conn)
	waiter := newLinkedTask(t, conn, userActor, "Ship it", "o/r#7")
	dep := mustCreateTask(t, conn, tasks.NewTask{Title: "Already done"})
	mustDone(t, conn, dep.ID)
	r := newUnblockRig(t, conn)

	b := mustAddBlocker(t, conn, waiter.ID, tasks.BlockerTarget{Kind: tasks.BlockerTask, BlockingTaskID: dep.ID})
	if b.ResolvedAt == "" {
		t.Fatalf("blocker = %+v, want resolved at once", b)
	}
	r.settle()
	if len(r.ft.got) != 0 {
		t.Fatalf("adding a done task's blocker notified: %+v", r.ft.got)
	}

	// Reopened and finished again: notifies.
	if _, err := tasks.SetState(conn, userActor, dep.ID, tasks.StateInProgress); err != nil {
		t.Fatal(err)
	}
	mustDone(t, conn, dep.ID)
	r.settle()
	if len(r.ft.got) != 1 {
		t.Fatalf("later resolution delivered %+v, want 1", r.ft.got)
	}
}

// A held Unblocked is dropped when, by the time it is due, its blocker was
// removed or has been unresolved.
func TestUnblockDroppedWhenBlockerRemovedOrUnresolvedWithinHold(t *testing.T) {
	merged := prLookup(map[string]tasks.ResourceStatus{"pr:o/r#4498": {Done: true, Label: "merged"}})
	open := prLookup(map[string]tasks.ResourceStatus{"pr:o/r#4498": {Done: false, Label: "open"}})
	for _, c := range []struct {
		name string
		undo func(t *testing.T, conn *sql.DB, b tasks.Blocker)
	}{
		{"removed", func(t *testing.T, conn *sql.DB, b tasks.Blocker) {
			must(t, tasks.RemoveBlocker(conn, userActor, b.ID))
		}},
		{"unresolved", func(t *testing.T, conn *sql.DB, b tasks.Blocker) {
			if _, err := tasks.ResolveBlockers(conn, open); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			conn := unreadTestDB(t)
			twoWorktrees(t, conn)
			waiter := newLinkedTask(t, conn, userActor, "Ship it", "o/r#7")
			b := mustAddBlocker(t, conn, waiter.ID, tasks.BlockerTarget{Kind: tasks.BlockerResource, ResourceType: "pr", ResourceID: "o/r#4498"})
			r := newUnblockRig(t, conn)
			if _, err := tasks.ResolveBlockers(conn, merged); err != nil {
				t.Fatal(err)
			}
			r.pass() // found, held
			c.undo(t, conn, b)
			r.now = r.now.Add(time.Minute)
			r.pass()
			if len(r.ft.got) != 0 {
				t.Fatalf("delivered %+v, want nothing", r.ft.got)
			}
		})
	}
}
