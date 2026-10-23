package tasks

import (
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
)

var agent = Actor{Kind: ActorAgent, Session: "s1"}

func mustSetState(t *testing.T, conn *sql.DB, id int64, to State) StateChange {
	t.Helper()
	sc, err := SetState(conn, user, id, to)
	if err != nil {
		t.Fatal(err)
	}
	return sc
}

// eventExists reports whether task_events still has row id.
func eventExists(t *testing.T, conn *sql.DB, id int64) bool {
	t.Helper()
	var n int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM task_events WHERE id = ?`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n == 1
}

func eventCount(t *testing.T, conn *sql.DB, taskID int64) int {
	t.Helper()
	es, err := Events(conn, taskID)
	if err != nil {
		t.Fatal(err)
	}
	return len(es)
}

// resolvedEventID reads a blocker's resolved_event_id (0 when NULL).
func resolvedEventID(t *testing.T, conn *sql.DB, blockerID int64) int64 {
	t.Helper()
	var id sql.NullInt64
	if err := conn.QueryRow(`SELECT resolved_event_id FROM task_blockers WHERE id = ?`, blockerID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id.Int64
}

func eventByID(t *testing.T, conn *sql.DB, taskID, id int64) Event {
	t.Helper()
	es, err := Events(conn, taskID)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range es {
		if e.ID == id {
			return e
		}
	}
	t.Fatalf("task %d has no event %d", taskID, id)
	return Event{}
}

func stateEventPayload(t *testing.T, conn *sql.DB, taskID, id int64) stateChangePayload {
	t.Helper()
	var p stateChangePayload
	if err := json.Unmarshal(eventByID(t, conn, taskID, id).Payload, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func noTaskResolutions(t *testing.T, conn *sql.DB) {
	t.Helper()
	if rs := mustResolve(t, conn, nil); len(rs) != 0 {
		t.Fatalf("after-commit pass found task blockers to move: %+v", rs)
	}
}

func TestStateEventPayloadCarriesPreviousTimestamps(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "T")
	started := mustSetState(t, conn, tk.ID, StateInProgress)
	done := mustSetState(t, conn, tk.ID, StateDone)
	p := stateEventPayload(t, conn, tk.ID, done.EventID)
	if p.From != StateInProgress || p.To != StateDone || p.PrevStartedAt == nil || *p.PrevStartedAt != started.StartedAt ||
		p.PrevCompletedAt == nil || *p.PrevCompletedAt != "" || len(p.Cascade) != 0 {
		t.Fatalf("payload = %+v", p)
	}
}

func TestUndoStateChangeRestoresStateAndTimestamps(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "T")
	started := mustSetState(t, conn, tk.ID, StateInProgress)
	// Make the previous timestamps distinguishable from the undo's now().
	if _, err := conn.Exec(`UPDATE tasks SET started_at = '2020-01-01T00:00:00Z' WHERE id = ?`, tk.ID); err != nil {
		t.Fatal(err)
	}
	done := mustSetState(t, conn, tk.ID, StateDone)
	before := eventCount(t, conn, tk.ID)
	v := mustVersion(t, conn)

	if err := UndoStateChange(conn, user, tk.ID, done.EventID); err != nil {
		t.Fatal(err)
	}
	got := mustGet(t, conn, tk.ID)
	if got.State != StateInProgress || got.StartedAt != "2020-01-01T00:00:00Z" || got.CompletedAt != "" {
		t.Fatalf("after undo: state %s started %q completed %q", got.State, got.StartedAt, got.CompletedAt)
	}
	if eventExists(t, conn, done.EventID) || eventCount(t, conn, tk.ID) != before-1 {
		t.Fatal("undo did not delete exactly the state event")
	}
	if mustVersion(t, conn) <= v {
		t.Fatal("undo did not bump the version")
	}

	// Undoing the first change too takes the task back to not started.
	if err := UndoStateChange(conn, user, tk.ID, started.EventID); err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, conn, tk.ID); got.State != StateNotStarted || got.StartedAt != "" {
		t.Fatalf("after second undo: %+v", got)
	}
}

func TestUndoStateChangeConflicts(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "T")
	first := mustSetState(t, conn, tk.ID, StateDone)

	// A newer change: only the newest is undoable.
	second := mustSetState(t, conn, tk.ID, StateInProgress)
	v := mustVersion(t, conn)
	if err := UndoStateChange(conn, user, tk.ID, first.EventID); !errors.Is(err, ErrUndoConflict) {
		t.Fatalf("undo of an older change = %v, want ErrUndoConflict", err)
	}
	if got := mustGet(t, conn, tk.ID); got.State != StateInProgress || !eventExists(t, conn, first.EventID) {
		t.Fatalf("refused undo changed something: %+v", got)
	}
	if mustVersion(t, conn) != v {
		t.Fatal("refused undo bumped the version")
	}

	// The value changed with no newer event (another writer, say).
	if _, err := conn.Exec(`UPDATE tasks SET state = 'not_started' WHERE id = ?`, tk.ID); err != nil {
		t.Fatal(err)
	}
	if err := UndoStateChange(conn, user, tk.ID, second.EventID); !errors.Is(err, ErrUndoConflict) {
		t.Fatalf("undo after the value changed = %v, want ErrUndoConflict", err)
	}
	if _, err := conn.Exec(`UPDATE tasks SET state = 'in_progress' WHERE id = ?`, tk.ID); err != nil {
		t.Fatal(err)
	}

	// Already undone.
	if err := UndoStateChange(conn, user, tk.ID, second.EventID); err != nil {
		t.Fatal(err)
	}
	if err := UndoStateChange(conn, user, tk.ID, second.EventID); !errors.Is(err, ErrUndoConflict) {
		t.Fatalf("second undo = %v, want ErrUndoConflict", err)
	}
	if err := Undo(conn, user, second.EventID); !errors.Is(err, ErrUndoConflict) {
		t.Fatalf("Undo of an undone event = %v, want ErrUndoConflict", err)
	}
}

func TestUndoInvalidAndNotFound(t *testing.T) {
	conn := newDB(t)
	tk, other := mustCreate(t, conn, "T"), mustCreate(t, conn, "O")
	sc := mustSetState(t, conn, tk.ID, StateDone)
	created := eventsOfType(t, conn, tk.ID, EventTaskCreated)[0]

	cases := []struct {
		name string
		err  error
		want error
	}{
		{"not undoable type", Undo(conn, user, created.ID), ErrInvalid},
		{"typed, not undoable type", UndoStateChange(conn, user, tk.ID, created.ID), ErrInvalid},
		{"another task's event", UndoStateChange(conn, user, other.ID, sc.EventID), ErrInvalid},
		{"delete undo of a state event", UndoDelete(conn, user, tk.ID, sc.EventID), ErrInvalid},
		{"no such event", Undo(conn, user, 99999), ErrNotFound},
		{"typed, no such event", UndoStateChange(conn, user, tk.ID, 99999), ErrNotFound},
		{"no such task", UndoStateChange(conn, user, 99999, sc.EventID), ErrInvalid},
		{"system actor", Undo(conn, Actor{Kind: ActorSystem}, sc.EventID), ErrInvalid},
	}
	for _, c := range cases {
		if !errors.Is(c.err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.name, c.err, c.want)
		}
	}
	if got := mustGet(t, conn, tk.ID); got.State != StateDone {
		t.Fatalf("a refused undo changed the task: %+v", got)
	}

	// The event's task deleted since: not found.
	if _, err := Delete(conn, user, tk.ID); err != nil {
		t.Fatal(err)
	}
	if err := UndoStateChange(conn, user, tk.ID, sc.EventID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("undo on a deleted task = %v, want ErrNotFound", err)
	}
}

// Review focus 1: undoing a completion that unblocked another task puts
// the blocker back and deletes both events.
func TestUndoCompletionPutsCascadeBack(t *testing.T) {
	conn := newDB(t)
	a, b := mustCreate(t, conn, "A"), mustCreate(t, conn, "B")
	blk := mustAddBlocker(t, conn, a.ID, taskTarget(b.ID))
	aEvents := eventCount(t, conn, a.ID)

	sc := mustSetState(t, conn, b.ID, StateDone)
	p := stateEventPayload(t, conn, b.ID, sc.EventID)
	if len(p.Cascade) != 1 || p.Cascade[0].BlockerID != blk.ID || !p.Cascade[0].Resolved {
		t.Fatalf("cascade = %+v", p.Cascade)
	}
	resolveEv := p.Cascade[0].EventID
	if e := eventByID(t, conn, a.ID, resolveEv); e.Type != EventTaskBlockerResolved || e.Actor != ActorSystem {
		t.Fatalf("cascade event = %+v", e)
	}
	if resolvedEventID(t, conn, blk.ID) != resolveEv {
		t.Fatal("resolved_event_id not recorded")
	}
	noTaskResolutions(t, conn) // resolved in the transaction

	if err := UndoStateChange(conn, user, b.ID, sc.EventID); err != nil {
		t.Fatal(err)
	}
	got := onlyBlocker(t, conn, a.ID)
	if got.ResolvedAt != "" || got.ResolvedAuto || got.ResolvedReason != "" || resolvedEventID(t, conn, blk.ID) != 0 {
		t.Fatalf("blocker after undo = %+v", got)
	}
	if eventExists(t, conn, resolveEv) || eventExists(t, conn, sc.EventID) {
		t.Fatal("undo left a cascade or state event")
	}
	if n := eventCount(t, conn, a.ID); n != aEvents {
		t.Fatalf("A has %d events after undo, want %d (no unresolve event)", n, aEvents)
	}
	if tk := mustGet(t, conn, a.ID); !tk.Blocked {
		t.Fatal("A not blocked again")
	}
	noTaskResolutions(t, conn)
}

func TestUndoDeletePutsDeletedCascadeBack(t *testing.T) {
	conn := newDB(t)
	a, b := mustCreate(t, conn, "A"), mustCreate(t, conn, "B")
	blk := mustAddBlocker(t, conn, a.ID, taskTarget(b.ID))
	ev, err := Delete(conn, user, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := onlyBlocker(t, conn, a.ID); got.ResolvedReason != "deleted" || resolvedEventID(t, conn, blk.ID) == 0 {
		t.Fatalf("blocker after delete = %+v", got)
	}
	cascadeEv := resolvedEventID(t, conn, blk.ID)
	noTaskResolutions(t, conn)

	if err := UndoDelete(conn, user, b.ID, ev); err != nil {
		t.Fatal(err)
	}
	mustGet(t, conn, b.ID)
	if got := onlyBlocker(t, conn, a.ID); got.ResolvedAt != "" {
		t.Fatalf("blocker after undo = %+v", got)
	}
	if eventExists(t, conn, ev) || eventExists(t, conn, cascadeEv) {
		t.Fatal("undo left the delete or cascade event")
	}
	noTaskResolutions(t, conn)
}

// Leaving done unresolves in the transaction; undoing that reopen restores
// the earlier resolution exactly, writing no event.
func TestUndoReopenRestoresResolutionWithoutEvents(t *testing.T) {
	conn := newDB(t)
	a, b := mustCreate(t, conn, "A"), mustCreate(t, conn, "B")
	blk := mustAddBlocker(t, conn, a.ID, taskTarget(b.ID))
	mustSetState(t, conn, b.ID, StateDone)
	resolved := onlyBlocker(t, conn, a.ID)
	resolveEv := resolvedEventID(t, conn, blk.ID)
	aEvents := eventCount(t, conn, a.ID)

	reopen := mustSetState(t, conn, b.ID, StateInProgress)
	p := stateEventPayload(t, conn, b.ID, reopen.EventID)
	if len(p.Cascade) != 1 || p.Cascade[0].Resolved || p.Cascade[0].PrevResolvedEventID != resolveEv {
		t.Fatalf("reopen cascade = %+v", p.Cascade)
	}
	unresolveEv := p.Cascade[0].EventID
	if e := eventByID(t, conn, a.ID, unresolveEv); e.Type != EventTaskBlockerUnresolved || e.Actor != ActorSystem {
		t.Fatalf("unresolve event = %+v", e)
	}
	if onlyBlocker(t, conn, a.ID).ResolvedAt != "" || resolvedEventID(t, conn, blk.ID) != 0 {
		t.Fatal("reopen did not unresolve")
	}
	noTaskResolutions(t, conn)

	if err := UndoStateChange(conn, user, b.ID, reopen.EventID); err != nil {
		t.Fatal(err)
	}
	if got := onlyBlocker(t, conn, a.ID); got != resolved {
		t.Fatalf("blocker after undo = %+v, want %+v", got, resolved)
	}
	if resolvedEventID(t, conn, blk.ID) != resolveEv {
		t.Fatal("resolved_event_id not restored")
	}
	if eventExists(t, conn, unresolveEv) || eventCount(t, conn, a.ID) != aEvents {
		t.Fatal("undo left the unresolve event or wrote a new one")
	}
	noTaskResolutions(t, conn)
}

// Reopening a blocked task settles its own task blockers in the same
// transaction, and its undo takes that back too.
func TestReopenSettlesOwnTaskBlockersInTx(t *testing.T) {
	conn := newDB(t)
	a, b := mustCreate(t, conn, "A"), mustCreate(t, conn, "B")
	blk := mustAddBlocker(t, conn, a.ID, taskTarget(b.ID))
	mustSetState(t, conn, a.ID, StateDone)
	mustSetState(t, conn, b.ID, StateDone) // A is done: its blocker is left alone
	if onlyBlocker(t, conn, a.ID).ResolvedAt != "" {
		t.Fatal("blocker of a done task was resolved")
	}
	reopen := mustSetState(t, conn, a.ID, StateInProgress)
	if got := onlyBlocker(t, conn, a.ID); got.ResolvedAt == "" || got.ResolvedReason != "done" {
		t.Fatalf("own blocker after reopen = %+v", got)
	}
	p := stateEventPayload(t, conn, a.ID, reopen.EventID)
	if len(p.Cascade) != 1 || p.Cascade[0].BlockerID != blk.ID || !p.Cascade[0].Resolved {
		t.Fatalf("cascade = %+v", p.Cascade)
	}
	noTaskResolutions(t, conn)
	if err := UndoStateChange(conn, user, a.ID, reopen.EventID); err != nil {
		t.Fatal(err)
	}
	if got := onlyBlocker(t, conn, a.ID); got.ResolvedAt != "" || eventExists(t, conn, p.Cascade[0].EventID) {
		t.Fatalf("blocker after undo = %+v", got)
	}
}

// A cascade blocker whose resolution changed since is left alone; its
// cascade event still goes.
func TestUndoLeavesCascadeBlockerChangedSince(t *testing.T) {
	conn := newDB(t)
	a, c, b := mustCreate(t, conn, "A"), mustCreate(t, conn, "C"), mustCreate(t, conn, "B")
	changed := mustAddBlocker(t, conn, a.ID, taskTarget(b.ID))
	removed := mustAddBlocker(t, conn, c.ID, taskTarget(b.ID))
	sc := mustSetState(t, conn, b.ID, StateDone)
	p := stateEventPayload(t, conn, b.ID, sc.EventID)
	if len(p.Cascade) != 2 {
		t.Fatalf("cascade = %+v", p.Cascade)
	}
	// One is now resolved by hand (as far as the row says), the other gone.
	if _, err := conn.Exec(`UPDATE task_blockers SET resolved_auto = 0, resolved_reason = '', resolved_event_id = NULL
	                         WHERE id = ?`, changed.ID); err != nil {
		t.Fatal(err)
	}
	if err := RemoveBlocker(conn, user, removed.ID); err != nil {
		t.Fatal(err)
	}
	if err := UndoStateChange(conn, user, b.ID, sc.EventID); err != nil {
		t.Fatal(err)
	}
	if got := onlyBlocker(t, conn, a.ID); got.ResolvedAt == "" || got.ResolvedAuto {
		t.Fatalf("hand-resolved blocker changed by undo: %+v", got)
	}
	for _, e := range p.Cascade {
		if eventExists(t, conn, e.EventID) {
			t.Fatalf("cascade event %d left behind", e.EventID)
		}
	}
}

func TestSubtaskCheckPayloadAndUndo(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "T")
	s, err := AddSubtask(conn, user, tk.ID, "s")
	if err != nil {
		t.Fatal(err)
	}
	s2, err := AddSubtask(conn, user, tk.ID, "s2")
	if err != nil {
		t.Fatal(err)
	}
	ch, err := SetSubtaskChecked(conn, user, s.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if p := payloadOf(t, eventByID(t, conn, tk.ID, ch.EventID)); p["from"] != false || p["to"] != true || p["subtask_id"] != float64(s.ID) {
		t.Fatalf("checked payload = %v", p)
	}
	// Another subtask's check is not "newer" for this one.
	if _, err := SetSubtaskChecked(conn, user, s2.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := UndoSubtaskCheck(conn, user, s2.ID, ch.EventID); !errors.Is(err, ErrInvalid) {
		t.Fatalf("undo against another subtask = %v, want ErrInvalid", err)
	}
	v := mustVersion(t, conn)
	if err := UndoSubtaskCheck(conn, user, s.ID, ch.EventID); err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, conn, tk.ID).Subtasks[0]; got.Checked || eventExists(t, conn, ch.EventID) {
		t.Fatalf("after undo: %+v", got)
	}
	if mustVersion(t, conn) <= v {
		t.Fatal("undo did not bump the version")
	}
	if err := UndoSubtaskCheck(conn, user, s.ID, ch.EventID); !errors.Is(err, ErrUndoConflict) {
		t.Fatalf("second undo = %v", err)
	}

	// Newer check event, then an undo through the dispatcher.
	on, _ := SetSubtaskChecked(conn, user, s.ID, true)
	off, _ := SetSubtaskChecked(conn, user, s.ID, false)
	if err := Undo(conn, user, on.EventID); !errors.Is(err, ErrUndoConflict) {
		t.Fatalf("undo of an older check = %v", err)
	}
	if err := Undo(conn, user, off.EventID); err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, conn, tk.ID).Subtasks[0]; !got.Checked {
		t.Fatal("undoing the uncheck did not check it again")
	}
	// Value changed with no event.
	if _, err := conn.Exec(`UPDATE task_subtasks SET checked = 0 WHERE id = ?`, s.ID); err != nil {
		t.Fatal(err)
	}
	if err := Undo(conn, user, on.EventID); !errors.Is(err, ErrUndoConflict) {
		t.Fatalf("undo after the value changed = %v", err)
	}
}

// Review focus 4: undoing a delete brings back the task with its unread
// agent events and writes nothing new.
func TestUndoDeleteKeepsHistoryAndConflicts(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "T")
	t2 := "T2"
	if _, err := Update(conn, agent, tk.ID, Patch{Title: &t2}); err != nil {
		t.Fatal(err)
	}
	ev, err := Delete(conn, user, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := Undo(conn, user, ev); err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, conn, tk.ID); got.Title != "T2" {
		t.Fatalf("restored task = %+v", got)
	}
	if es := eventsOfType(t, conn, tk.ID, EventTaskEdited); len(es) != 1 || es[0].Actor != ActorAgent {
		t.Fatalf("agent events after undo = %+v", es)
	}
	if eventExists(t, conn, ev) || len(eventsOfType(t, conn, tk.ID, EventTaskDeleted)) != 0 {
		t.Fatal("delete event left behind")
	}
	if err := UndoDelete(conn, user, tk.ID, ev); !errors.Is(err, ErrUndoConflict) {
		t.Fatalf("second undo = %v", err)
	}
	// Deleted again: the old event is gone, and the new one's deleted_at
	// is what must still hold.
	ev2, err := Delete(conn, user, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`UPDATE tasks SET deleted_at = '2020-01-01T00:00:00Z' WHERE id = ?`, tk.ID); err != nil {
		t.Fatal(err)
	}
	if err := UndoDelete(conn, user, tk.ID, ev2); !errors.Is(err, ErrUndoConflict) {
		t.Fatalf("undo with a different deleted_at = %v", err)
	}
}

func TestUndoReconcilesHolds(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "T")
	mustAddBlocker(t, conn, tk.ID, resTarget("pr", "o/r#1"))
	sc := mustSetState(t, conn, tk.ID, StateDone)
	if len(liveHolds(t, conn)) != 0 {
		t.Fatal("a done task holds")
	}
	if err := UndoStateChange(conn, user, tk.ID, sc.EventID); err != nil {
		t.Fatal(err)
	}
	if !liveHolds(t, conn)[holdKey(tk.ID, "pr:o/r#1")] {
		t.Fatalf("holds after undo = %v", liveHolds(t, conn))
	}
}
