package tasks

import (
	"errors"
	"testing"
)

// An agent may undo only an agent's change; the user may undo anything.
func TestUndoAgentMayUndoOnlyAgentEvents(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "T")
	s, err := AddSubtask(conn, user, tk.ID, "s")
	if err != nil {
		t.Fatal(err)
	}
	userDone := mustSetState(t, conn, tk.ID, StateDone)
	userCheck, err := SetSubtaskChecked(conn, user, s.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	for name, err := range map[string]error{
		"Undo":             Undo(conn, agent, userDone.EventID),
		"UndoStateChange":  UndoStateChange(conn, agent, tk.ID, userDone.EventID),
		"UndoSubtaskCheck": UndoSubtaskCheck(conn, agent, s.ID, userCheck.EventID),
		"Undo (subtask)":   Undo(conn, agent, userCheck.EventID),
	} {
		if !errors.Is(err, ErrUndoForbidden) {
			t.Errorf("%s of the user's change by an agent = %v, want ErrUndoForbidden", name, err)
		}
	}
	got := mustGet(t, conn, tk.ID)
	if got.State != StateDone || !got.Subtasks[0].Checked || !eventExists(t, conn, userDone.EventID) {
		t.Fatalf("a refused undo changed something: %+v", got)
	}

	userDel, err := Delete(conn, user, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := UndoDelete(conn, agent, tk.ID, userDel); !errors.Is(err, ErrUndoForbidden) {
		t.Fatalf("agent undo of the user's delete = %v, want ErrUndoForbidden", err)
	}
	if err := Undo(conn, user, userDel); err != nil {
		t.Fatalf("user undo of the user's delete: %v", err)
	}

	// The agent's own change: the agent may undo it, and so may the user.
	agentReopen, err := SetState(conn, agent, tk.ID, StateInProgress)
	if err != nil {
		t.Fatal(err)
	}
	if err := Undo(conn, agent, agentReopen.EventID); err != nil {
		t.Fatalf("agent undo of its own change: %v", err)
	}
	agentReopen, err = SetState(conn, agent, tk.ID, StateInProgress)
	if err != nil {
		t.Fatal(err)
	}
	if err := Undo(conn, user, agentReopen.EventID); err != nil {
		t.Fatalf("user undo of an agent's change: %v", err)
	}
}

// An issued event whose subtask or task is gone since is a conflict, not
// "not found"; only an id never issued is ErrNotFound.
func TestUndoAfterSubtaskOrTaskGoneConflicts(t *testing.T) {
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
	removed, err := SetSubtaskChecked(conn, user, s.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := RemoveSubtask(conn, user, s.ID); err != nil {
		t.Fatal(err)
	}
	if err := Undo(conn, user, removed.EventID); !errors.Is(err, ErrUndoConflict) {
		t.Fatalf("undo of a removed subtask's check = %v, want ErrUndoConflict", err)
	}
	if err := UndoSubtaskCheck(conn, user, s.ID, removed.EventID); !errors.Is(err, ErrUndoConflict) {
		t.Fatalf("typed undo of a removed subtask's check = %v, want ErrUndoConflict", err)
	}

	check, err := SetSubtaskChecked(conn, user, s2.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	state := mustSetState(t, conn, tk.ID, StateInProgress)
	if _, err := Delete(conn, user, tk.ID); err != nil {
		t.Fatal(err)
	}
	if err := Undo(conn, user, check.EventID); !errors.Is(err, ErrUndoConflict) {
		t.Fatalf("undo of a deleted task's subtask check = %v, want ErrUndoConflict", err)
	}
	if err := Undo(conn, user, state.EventID); !errors.Is(err, ErrUndoConflict) {
		t.Fatalf("undo of a deleted task's state change = %v, want ErrUndoConflict", err)
	}
	if err := Undo(conn, user, 99999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("undo of an id never issued = %v, want ErrNotFound", err)
	}
}

// unblockable lists the task_blocker_resolved events among events that the
// Unblocked notifier would act on: system, auto, and marked neither on_add
// nor on_undo.
func unblockable(t *testing.T, events []Event) []Event {
	t.Helper()
	var out []Event
	for _, e := range events {
		if e.Type != EventTaskBlockerResolved || e.Actor != ActorSystem {
			continue
		}
		p := payloadOf(t, e)
		if p["auto"] == true && p["on_add"] != true && p["on_undo"] != true {
			out = append(out, e)
		}
	}
	return out
}

// The review's ordering: X is blocked by W; delete X, then W; undo X's
// delete, then W's (and the reverse). Neither undo may leave a notifiable
// resolution behind, nor any resolver churn in X's history.
func TestUndoDeletesInEitherOrderLeaveNoUnblocked(t *testing.T) {
	for _, order := range []string{"X then W", "W then X"} {
		t.Run(order, func(t *testing.T) {
			conn := newDB(t)
			x, w := mustCreate(t, conn, "X"), mustCreate(t, conn, "W")
			blk := mustAddBlocker(t, conn, x.ID, taskTarget(w.ID))
			xEvents := eventCount(t, conn, x.ID)
			xDel, err := Delete(conn, user, x.ID)
			if err != nil {
				t.Fatal(err)
			}
			wDel, err := Delete(conn, user, w.ID)
			if err != nil {
				t.Fatal(err)
			}
			first, second := xDel, wDel
			if order == "W then X" {
				first, second = wDel, xDel
			}

			if err := Undo(conn, user, first); err != nil {
				t.Fatal(err)
			}
			noTaskResolutions(t, conn) // settled in the undo's transaction
			if order == "X then W" {
				// W is still deleted: X's blocker is resolved, but quietly.
				if got := onlyBlocker(t, conn, x.ID); got.ResolvedAt == "" || got.ResolvedReason != "deleted" {
					t.Fatalf("blocker after undoing X's delete = %+v", got)
				}
				es, err := Events(conn, x.ID)
				if err != nil {
					t.Fatal(err)
				}
				if u := unblockable(t, es); len(u) != 0 {
					t.Fatalf("undo wrote a notifiable resolution: %+v", u)
				}
			}

			if err := Undo(conn, user, second); err != nil {
				t.Fatal(err)
			}
			noTaskResolutions(t, conn)
			if got := onlyBlocker(t, conn, x.ID); got.ResolvedAt != "" || resolvedEventID(t, conn, blk.ID) != 0 {
				t.Fatalf("blocker after both undos = %+v", got)
			}
			if !mustGet(t, conn, x.ID).Blocked {
				t.Fatal("X not blocked after both undos")
			}
			es, err := Events(conn, x.ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(es) != xEvents {
				t.Fatalf("X has %d events after both undos, want %d: %+v", len(es), xEvents, es)
			}
		})
	}
}

// Undoing a completion settles the restored task's own task blockers in
// its transaction, quietly: here a blocking task finished while X was done.
func TestUndoCompletionSettlesOwnBlockersQuietly(t *testing.T) {
	conn := newDB(t)
	x, w := mustCreate(t, conn, "X"), mustCreate(t, conn, "W")
	mustAddBlocker(t, conn, x.ID, taskTarget(w.ID))
	done := mustSetState(t, conn, x.ID, StateDone)
	mustSetState(t, conn, w.ID, StateDone) // X is done: its blocker is left alone
	if err := Undo(conn, user, done.EventID); err != nil {
		t.Fatal(err)
	}
	noTaskResolutions(t, conn)
	if got := onlyBlocker(t, conn, x.ID); got.ResolvedAt == "" || got.ResolvedReason != "done" {
		t.Fatalf("own blocker after the undo = %+v", got)
	}
	es, err := Events(conn, x.ID)
	if err != nil {
		t.Fatal(err)
	}
	if u := unblockable(t, es); len(u) != 0 {
		t.Fatalf("undo wrote a notifiable resolution: %+v", u)
	}
}
