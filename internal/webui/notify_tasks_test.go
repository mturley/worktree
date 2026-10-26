package webui

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/notifyprefs"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/tasks"
)

var (
	agentActor = tasks.Actor{Kind: tasks.ActorAgent, Session: "s1"}
	userActor  = tasks.Actor{Kind: tasks.ActorUser}
)

// newLinkedTask creates a task linking the PR both twoWorktrees track, so
// both worktrees hold it in scope (implicitly).
func newLinkedTask(t *testing.T, conn *sql.DB, a tasks.Actor, title, prID string) tasks.Task {
	t.Helper()
	tk, err := tasks.Create(conn, a, tasks.NewTask{Title: title, Focus: []tasks.LinkTarget{
		{Kind: tasks.LinkResource, ResourceType: "pr", ResourceID: prID},
	}})
	if err != nil {
		t.Fatal(err)
	}
	return tk
}

// setTaskState records a task event as a: a state change, since edits are
// not task events.
func setTaskState(t *testing.T, conn *sql.DB, a tasks.Actor, id int64, s tasks.State) {
	t.Helper()
	if _, err := tasks.SetState(conn, a, id, s); err != nil {
		t.Fatal(err)
	}
}

func readyCursor(t *testing.T, conn *sql.DB) notifyCursor {
	t.Helper()
	c, err := initNotifyCursor(conn)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestSummaryNamesTasks(t *testing.T) {
	res := notifyBatch{WorktreePath: "/w/a", ResourceType: "pr"}
	task := notifyBatch{WorktreePath: "/w/a", ResourceType: "task"}
	cases := []struct {
		in   []notifyBatch
		want string
	}{
		{[]notifyBatch{res, res}, "2 resources have new events"},
		{[]notifyBatch{task, task}, "2 tasks have new events"},
		{[]notifyBatch{res, task, task}, "3 resources and tasks have new events"},
	}
	for _, c := range cases {
		if got := summarizeBatches(c.in).Body; got != c.want {
			t.Errorf("got %q, want %q", got, c.want)
		}
	}
}

func TestTaskNotifyCursorStartsAtMax(t *testing.T) {
	conn := unreadTestDB(t)
	a, _ := twoWorktrees(t, conn)
	notifyprefs.SetAll(conn, a, true)
	tk := newLinkedTask(t, conn, agentActor, "Old work", "o/r#7")
	setTaskState(t, conn, agentActor, tk.ID, tasks.StateInProgress)

	ft := &fakeTransport{}
	s := &Server{DB: conn, transport: ft}
	c := readyCursor(t, conn) // a restart, after those events
	s.notifyPass(&c)
	if len(ft.got) != 0 {
		t.Fatalf("restart replayed task history: %+v", ft.got)
	}
	var max int64
	conn.QueryRow(`SELECT MAX(id) FROM task_events`).Scan(&max)
	if c.taskID != max {
		t.Fatalf("task cursor = %d, want MAX(id) %d", c.taskID, max)
	}
}

func TestTaskNotifyUninitialisedCursorNeverReplays(t *testing.T) {
	conn := unreadTestDB(t)
	a, _ := twoWorktrees(t, conn)
	notifyprefs.SetAll(conn, a, true)
	tk := newLinkedTask(t, conn, agentActor, "Old work", "o/r#7")
	ft := &fakeTransport{}
	s := &Server{DB: conn, transport: ft}
	var c notifyCursor // the boot initialisation failed
	s.notifyPass(&c)
	if len(ft.got) != 0 {
		t.Fatalf("replayed history: %+v", ft.got)
	}
	setTaskState(t, conn, agentActor, tk.ID, tasks.StateInProgress)
	s.notifyPass(&c)
	if len(ft.got) != 1 || ft.got[0].Title != "Old work" {
		t.Fatalf("after initialising, got %+v, want one batch for the state change", ft.got)
	}
}

func TestTaskNotifyLinkedResourceToggleNotifiesThatWorktreeOnce(t *testing.T) {
	conn := unreadTestDB(t)
	a, _ := twoWorktrees(t, conn) // b has the task in scope too, but no toggle
	notifyprefs.SetResource(conn, a, "pr", "o/r#7", true)
	ft := &fakeTransport{}
	s := &Server{DB: conn, transport: ft}
	c := readyCursor(t, conn)

	tk := newLinkedTask(t, conn, agentActor, "Fix the flaky test", "o/r#7")
	setTaskState(t, conn, agentActor, tk.ID, tasks.StateInProgress)
	s.notifyPass(&c)
	s.notifyPass(&c)

	if len(ft.got) != 1 {
		t.Fatalf("delivered %d batches, want exactly 1: %+v", len(ft.got), ft.got)
	}
	b := ft.got[0]
	id := strconv.FormatInt(tk.ID, 10)
	if b.WorktreePath != a || b.ResourceType != "task" || b.ResourceID != id {
		t.Fatalf("batch target = %+v", b)
	}
	if b.Title != "Fix the flaky test" || b.Subtitle != filepath.Base(a) {
		t.Fatalf("title/subtitle = %q / %q", b.Title, b.Subtitle)
	}
	evs, _ := tasks.Events(conn, tk.ID)
	newest := taskEventToTimeline(evs[0], tasks.Task{ID: tk.ID, Title: "Fix the flaky test"}).Title
	want := fmt.Sprintf("%s (+%d more)", newest, len(evs)-1)
	if b.Body != want {
		t.Fatalf("body = %q, want %q", b.Body, want)
	}
	if b.Tag != notifyTag(a, "task", id) {
		t.Fatalf("tag = %q", b.Tag)
	}
	if b.Event != b.Body || !strings.HasPrefix(b.Resource, "T"+id+": ") || b.Description == "" {
		t.Fatalf("command placeholders = %q / %q / %q", b.Event, b.Resource, b.Description)
	}
}

func TestTaskNotifyUntoggledResourceDoesNotNotify(t *testing.T) {
	conn := unreadTestDB(t)
	a, _ := twoWorktrees(t, conn)
	if err := resources.Add(conn, a, resources.Resource{Type: "pr", ID: "o/r#8", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	notifyprefs.SetResource(conn, a, "pr", "o/r#8", true) // a toggle, but not on the task's link
	ft := &fakeTransport{}
	s := &Server{DB: conn, transport: ft}
	c := readyCursor(t, conn)
	newLinkedTask(t, conn, agentActor, "Elsewhere", "o/r#7")
	s.notifyPass(&c)
	if len(ft.got) != 0 {
		t.Fatalf("notified without a toggle on a linked resource: %+v", ft.got)
	}
}

func TestTaskNotifyAllNotifies(t *testing.T) {
	conn := unreadTestDB(t)
	_, b := twoWorktrees(t, conn)
	notifyprefs.SetAll(conn, b, true)
	ft := &fakeTransport{}
	s := &Server{DB: conn, transport: ft}
	c := readyCursor(t, conn)
	newLinkedTask(t, conn, agentActor, "Agent task", "o/r#7")
	s.notifyPass(&c)
	if len(ft.got) != 1 || ft.got[0].WorktreePath != b || ft.got[0].Title != "Agent task" {
		t.Fatalf("got %+v, want one batch for b", ft.got)
	}
}

func TestTaskNotifyUserEventsNeverNotify(t *testing.T) {
	conn := unreadTestDB(t)
	a, b := twoWorktrees(t, conn)
	notifyprefs.SetAll(conn, a, true)
	notifyprefs.SetResource(conn, b, "pr", "o/r#7", true)
	ft := &fakeTransport{}
	s := &Server{DB: conn, transport: ft}
	c := readyCursor(t, conn)
	tk := newLinkedTask(t, conn, userActor, "Mine", "o/r#7")
	setTaskState(t, conn, userActor, tk.ID, tasks.StateInProgress)
	s.notifyPass(&c)
	if len(ft.got) != 0 {
		t.Fatalf("the user's own events notified: %+v", ft.got)
	}
	// The cursor still moved past them: a later agent event notifies alone.
	setTaskState(t, conn, agentActor, tk.ID, tasks.StateDone)
	s.notifyPass(&c)
	if len(ft.got) != 2 || ft.got[0].Body != ft.got[1].Body || strings.Contains(ft.got[0].Body, "more") {
		t.Fatalf("got %+v, want one single-event batch per worktree", ft.got)
	}
}

func TestTaskNotifyGlobalTaskNotifiesNobody(t *testing.T) {
	conn := unreadTestDB(t)
	a, b := twoWorktrees(t, conn)
	notifyprefs.SetAll(conn, a, true)
	notifyprefs.SetAll(conn, b, true)
	ft := &fakeTransport{}
	s := &Server{DB: conn, transport: ft}
	c := readyCursor(t, conn)
	if _, err := tasks.Create(conn, agentActor, tasks.NewTask{Title: "Global"}); err != nil {
		t.Fatal(err)
	}
	s.notifyPass(&c)
	if len(ft.got) != 0 {
		t.Fatalf("a global task notified: %+v", ft.got)
	}
}

func TestTaskNotifyDeletedTaskNeverNotifies(t *testing.T) {
	conn := unreadTestDB(t)
	a, _ := twoWorktrees(t, conn)
	notifyprefs.SetAll(conn, a, true)
	ft := &fakeTransport{}
	s := &Server{DB: conn, transport: ft}
	c := readyCursor(t, conn)
	tk := newLinkedTask(t, conn, agentActor, "Doomed", "o/r#7")
	if _, err := tasks.Delete(conn, agentActor, tk.ID); err != nil {
		t.Fatal(err)
	}
	s.notifyPass(&c)
	if len(ft.got) != 0 {
		t.Fatalf("a deleted task notified: %+v", ft.got)
	}
}

func TestTaskNotifyFloodFoldsIntoSummaryWithWatcherBatches(t *testing.T) {
	conn := unreadTestDB(t)
	a, _ := twoWorktrees(t, conn)
	notifyprefs.SetAll(conn, a, true)
	ft := &fakeTransport{}
	s := &Server{DB: conn, transport: ft}
	c := readyCursor(t, conn)
	// Neither source alone passes the cap; together they do.
	const nWatcher, nTasks = 3, notifyMaxPerPass - 2
	for i := 0; i < nWatcher; i++ {
		id := fmt.Sprintf("o/r#%d", 100+i)
		if err := resources.Add(conn, a, resources.Resource{Type: "pr", ID: id, URL: "u"}); err != nil {
			t.Fatal(err)
		}
		insertTypedEvent(t, conn, fmt.Sprintf("e%d", i), "2099-01-01T00:00:00Z", "pr_comment", "x", "pr", id)
	}
	for i := 0; i < nTasks; i++ {
		newLinkedTask(t, conn, agentActor, fmt.Sprintf("Task %d", i), "o/r#7")
	}
	s.notifyPass(&c)
	if len(ft.got) != 1 {
		t.Fatalf("delivered %d notifications, want 1 summary: %+v", len(ft.got), ft.got)
	}
	if b := ft.got[0]; b.Title != "New activity" || b.WorktreePath != a ||
		!strings.HasPrefix(b.Body, strconv.Itoa(nWatcher+nTasks)+" ") {
		t.Fatalf("summary = %+v", b)
	}
}
