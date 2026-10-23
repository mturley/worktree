package webui

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/mturley/worktree/internal/notifyprefs"
	"github.com/mturley/worktree/internal/tasks"
)

func undoIDOf(t *testing.T, body []byte) (int64, bool) {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatal(err)
	}
	raw, ok := m["undo_event_id"]
	if !ok {
		return 0, false
	}
	var id int64
	if err := json.Unmarshal(raw, &id); err != nil {
		t.Fatal(err)
	}
	return id, true
}

func TestUndoStateEndpointOmitsIDWhenNothingChanged(t *testing.T) {
	s, _ := tasksServer(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "T"})

	rec := serveTasks(t, s, http.MethodPost, "/api/tasks/state", map[string]any{"id": tk.ID, "state": "not_started"})
	if rec.Code != 200 {
		t.Fatalf("no-op state: %d %s", rec.Code, rec.Body)
	}
	if _, ok := undoIDOf(t, rec.Body.Bytes()); ok {
		t.Fatalf("a no-op carried undo_event_id: %s", rec.Body)
	}

	rec = serveTasks(t, s, http.MethodPost, "/api/tasks/state", map[string]any{"id": tk.ID, "state": "in_progress"})
	id, ok := undoIDOf(t, rec.Body.Bytes())
	if !ok || id == 0 {
		t.Fatalf("state change has no undo_event_id: %s", rec.Body)
	}

	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/undo", map[string]any{"event_id": id}); rec.Code != http.StatusNoContent {
		t.Fatalf("undo: %d %s", rec.Code, rec.Body)
	}
	if got, _ := tasks.Get(s.DB, tk.ID); got.State != tasks.StateNotStarted {
		t.Fatalf("state after undo = %s", got.State)
	}
	// The event is gone: a second undo is a conflict.
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/undo", map[string]any{"event_id": id}); rec.Code != http.StatusConflict {
		t.Fatalf("second undo: %d %s", rec.Code, rec.Body)
	}
}

func TestUndoEndpointErrorStatuses(t *testing.T) {
	s, _ := tasksServer(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "T"})
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/undo", map[string]any{"event_id": 99999}); rec.Code != http.StatusNotFound {
		t.Fatalf("never-issued event: %d %s", rec.Code, rec.Body)
	}
	var created int64
	if err := s.DB.QueryRow(`SELECT id FROM task_events WHERE task_id = ? AND type = ?`, tk.ID, tasks.EventTaskCreated).Scan(&created); err != nil {
		t.Fatal(err)
	}
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/undo", map[string]any{"event_id": created}); rec.Code != http.StatusBadRequest {
		t.Fatalf("non-undoable event: %d %s", rec.Code, rec.Body)
	}
	// A state change followed by a newer one conflicts.
	first, _ := tasks.SetState(s.DB, webUser, tk.ID, tasks.StateInProgress)
	if _, err := tasks.SetState(s.DB, webUser, tk.ID, tasks.StateDone); err != nil {
		t.Fatal(err)
	}
	rec := serveTasks(t, s, http.MethodPost, "/api/tasks/undo", map[string]any{"event_id": first.EventID})
	if rec.Code != http.StatusConflict {
		t.Fatalf("superseded: %d %s", rec.Code, rec.Body)
	}
	var e struct{ Error string }
	_ = json.Unmarshal(rec.Body.Bytes(), &e)
	if e.Error == "" {
		t.Fatalf("409 has no message: %s", rec.Body)
	}
}

func TestUndoSubtaskCheckEndpoint(t *testing.T) {
	s, _ := tasksServer(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "T"})
	sub, err := tasks.AddSubtask(s.DB, webUser, tk.ID, "step")
	if err != nil {
		t.Fatal(err)
	}
	check := func(checked bool) []byte {
		rec := serveTasks(t, s, http.MethodPost, "/api/tasks/subtasks/check", map[string]any{"subtask_id": sub.ID, "checked": checked})
		if rec.Code != 200 {
			t.Fatalf("check: %d %s", rec.Code, rec.Body)
		}
		return rec.Body.Bytes()
	}
	if _, ok := undoIDOf(t, check(false)); ok {
		t.Fatal("an unchanged check carried undo_event_id")
	}
	id, ok := undoIDOf(t, check(true))
	if !ok || id == 0 {
		t.Fatal("a check has no undo_event_id")
	}
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/undo", map[string]any{"event_id": id}); rec.Code != http.StatusNoContent {
		t.Fatalf("undo: %d %s", rec.Code, rec.Body)
	}
	if got, _ := tasks.Get(s.DB, tk.ID); got.Subtasks[0].Checked {
		t.Fatal("subtask still checked")
	}
}

func TestUndoDeleteEndpoint(t *testing.T) {
	s, _ := tasksServer(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "T"})
	rec := serveTasks(t, s, http.MethodPost, "/api/tasks/delete", map[string]any{"id": tk.ID})
	if rec.Code != 200 {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body)
	}
	id, ok := undoIDOf(t, rec.Body.Bytes())
	if !ok || id == 0 {
		t.Fatalf("delete has no undo_event_id: %s", rec.Body)
	}
	if _, err := tasks.Get(s.DB, tk.ID); err == nil {
		t.Fatal("task still readable after delete")
	}
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/undo", map[string]any{"event_id": id}); rec.Code != http.StatusNoContent {
		t.Fatalf("undo: %d %s", rec.Code, rec.Body)
	}
	if _, err := tasks.Get(s.DB, tk.ID); err != nil {
		t.Fatalf("task not back: %v", err)
	}
}

// Review focus 1: completing a task auto-resolves a task blocker on it;
// undoing the completion inside the notifier's hold must not notify.
func TestUndoCompletionWithCascadeSendsNoUnblocked(t *testing.T) {
	conn := unreadTestDB(t)
	a, _ := twoWorktrees(t, conn)
	notifyprefs.SetAll(conn, a, true)
	waiter := newLinkedTask(t, conn, userActor, "Ship it", "o/r#7")
	dep := blockOnTask(t, conn, waiter.ID)
	r := newUnblockRig(t, conn)

	rec := serveAll(t, r.s, http.MethodPost, "/api/tasks/state", map[string]any{"id": dep.ID, "state": "done"})
	id, ok := undoIDOf(t, rec.Body.Bytes())
	if rec.Code != 200 || !ok {
		t.Fatalf("complete: %d %s", rec.Code, rec.Body)
	}
	r.pass() // finds the system resolution event and holds it
	if rec := serveAll(t, r.s, http.MethodPost, "/api/tasks/undo", map[string]any{"event_id": id}); rec.Code != http.StatusNoContent {
		t.Fatalf("undo: %d %s", rec.Code, rec.Body)
	}
	r.settle()
	r.settle()
	if len(r.ft.got) != 0 {
		t.Fatalf("an undone completion notified: %+v", r.ft.got)
	}
	if got, _ := tasks.Get(conn, waiter.ID); !got.Blocked {
		t.Fatal("waiter is not blocked again")
	}
}

// Review focus 4: delete then undo a task with unread agent events: its
// unread count comes back and nothing new notifies.
func TestUndoDeleteRestoresUnreadAndNotifiesNothing(t *testing.T) {
	f := taskUnreadFixture(t)
	f.seed(t)
	notifyprefs.SetAll(f.s.DB, f.wt, true)
	want := f.worktree(t).UnreadCount
	if want == 0 {
		t.Fatal("fixture has no unread")
	}
	r := newUnblockRig(t, f.s.DB) // cursor starts past the seeded events

	rec := serveAll(t, r.s, http.MethodPost, "/api/tasks/delete", map[string]any{"id": f.both.ID})
	id, ok := undoIDOf(t, rec.Body.Bytes())
	if rec.Code != 200 || !ok {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body)
	}
	if got := f.worktree(t).UnreadCount; got >= want {
		t.Fatalf("delete left unread at %d (was %d)", got, want)
	}
	if rec := serveAll(t, r.s, http.MethodPost, "/api/tasks/undo", map[string]any{"event_id": id}); rec.Code != http.StatusNoContent {
		t.Fatalf("undo: %d %s", rec.Code, rec.Body)
	}
	if got := f.worktree(t).UnreadCount; got != want {
		t.Fatalf("unread after undo = %d, want %d", got, want)
	}
	r.settle()
	if len(r.ft.got) != 0 {
		t.Fatalf("delete+undo notified: %+v", r.ft.got)
	}
}

// Subtask check events carry boolean from/to; the timeline still decodes
// their text and ids.
func TestTaskEventPayloadDecodesSubtaskBooleans(t *testing.T) {
	p := parseTaskPayload(json.RawMessage(`{"subtask_id":7,"text":"step","from":false,"to":true}`))
	if p.Text != "step" || string(p.To) != "true" {
		t.Fatalf("payload = %+v", p)
	}
	if p.stateTo() != "" || p.stateFrom() != "" {
		t.Fatalf("booleans read as states: %q %q", p.stateFrom(), p.stateTo())
	}
	st := parseTaskPayload(json.RawMessage(`{"from":"not_started","to":"done"}`))
	if st.stateFrom() != "not_started" || st.stateTo() != "done" {
		t.Fatalf("state payload = %+v", st)
	}
}
