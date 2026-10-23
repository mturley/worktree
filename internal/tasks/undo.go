package tasks

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// ErrUndoConflict is returned when the change an undo names is no longer
// the current one: its event is gone (already undone), a newer change of
// the same kind followed it, or the value moved on. Nothing is undone.
var ErrUndoConflict = errors.New("changed since; nothing was undone")

// An undo puts back exactly what the write recorded in its event changed,
// including its cascade, and DELETES that event and every cascaded one: it
// writes no "reverted" event, so an accidental click leaves no history.
// Everything to restore comes from the stored event, never from the
// caller. Each undo is one inTx, followed (after commit) by a resolver pass
// and a hold reconcile, like any other write.

// loadUndoEvent reads event id inside tx. A missing event is
// ErrUndoConflict when its id was once used (task_events is AUTOINCREMENT,
// so ids are never reused: it was undone, or purged), and ErrNotFound when
// it never existed.
func loadUndoEvent(tx dbtx, id int64) (Event, error) {
	var e Event
	var payload string
	err := tx.QueryRowContext(bg,
		`SELECT id, task_id, ts, type, actor, actor_session, payload FROM task_events WHERE id = ?`, id).Scan(
		&e.ID, &e.TaskID, &e.TS, &e.Type, &e.Actor, &e.ActorSession, &payload)
	if errors.Is(err, sql.ErrNoRows) {
		var seq int64
		if err := tx.QueryRowContext(bg,
			`SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'task_events'), 0)`).Scan(&seq); err != nil {
			return Event{}, err
		}
		if id > 0 && id <= seq {
			return Event{}, ErrUndoConflict
		}
		return Event{}, fmt.Errorf("%w: no event %d", ErrNotFound, id)
	}
	if err != nil {
		return Event{}, err
	}
	e.Payload = json.RawMessage(payload)
	return e, nil
}

// undoEventFor loads event id for an undo of one of types on taskID:
// ErrInvalid when it is another type or another task's.
func undoEventFor(tx dbtx, id, taskID int64, types ...string) (Event, error) {
	e, err := loadUndoEvent(tx, id)
	if err != nil {
		return Event{}, err
	}
	ok := false
	for _, t := range types {
		ok = ok || e.Type == t
	}
	if !ok {
		return Event{}, fmt.Errorf("%w: event %d (%s) cannot be undone here", ErrInvalid, id, e.Type)
	}
	if e.TaskID != taskID {
		return Event{}, fmt.Errorf("%w: event %d is not task %d's", ErrInvalid, id, taskID)
	}
	return e, nil
}

func deleteEvent(tx dbtx, id int64) error {
	_, err := tx.ExecContext(bg, `DELETE FROM task_events WHERE id = ?`, id)
	return err
}

// undoCascadeTx reverses a cascade and deletes its events. A blocker is
// put back only while it is still as the cascade left it: a resolution
// only while resolved_event_id is still that event's, an unresolve only
// while still unresolved. One changed since (or removed) is left alone.
// No event is written either way, so a restored resolution never notifies
// again.
func undoCascadeTx(tx dbtx, cascade []cascadeEntry) error {
	for _, c := range cascade {
		var err error
		if c.Resolved {
			_, err = tx.ExecContext(bg,
				`UPDATE task_blockers SET resolved_at = NULL, resolved_auto = 0, resolved_reason = '', resolved_event_id = NULL
				  WHERE id = ? AND resolved_event_id = ?`, c.BlockerID, c.EventID)
		} else {
			_, err = tx.ExecContext(bg,
				`UPDATE task_blockers SET resolved_at = ?, resolved_auto = ?, resolved_reason = ?, resolved_event_id = ?
				  WHERE id = ? AND resolved_at IS NULL`,
				nullable(c.PrevResolvedAt), bit(c.PrevResolvedAuto), c.PrevResolvedReason, nullableID(c.PrevResolvedEventID), c.BlockerID)
		}
		if err != nil {
			return err
		}
		if err := deleteEvent(tx, c.EventID); err != nil {
			return err
		}
	}
	return nil
}

func nullableID(id int64) any {
	if id == 0 {
		return nil
	}
	return id
}

// afterUndo is what every undo runs after its commit: a resolver pass, for
// a blocker outside the cascade that putting the task back left out of
// line, and a hold reconcile (completing released holds, deleting released
// them all).
func afterUndo(conn *sql.DB) {
	resolveAfterWrite(conn)
	reconcileHoldsAfterWrite(conn)
}

// UndoStateChange reverses the task_state_changed event eventID of taskID:
// the state, started_at and completed_at go back to the event's previous
// values, its cascade is reversed, and the event and its cascade events
// are deleted. It applies only while the event is the task's newest state
// change and the task is still in the event's "to" state; otherwise
// ErrUndoConflict. ErrNotFound when the task or event is missing (or the
// task deleted); ErrInvalid when the event is not a state change of this
// task. User or agent only.
func UndoStateChange(conn *sql.DB, a Actor, taskID, eventID int64) error {
	if err := validActor(a); err != nil {
		return err
	}
	err := inTx(conn, func(tx dbtx) error {
		e, err := undoEventFor(tx, eventID, taskID, EventTaskStateChanged)
		if err != nil {
			return err
		}
		var p stateChangePayload
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		if p.PrevStartedAt == nil || p.PrevCompletedAt == nil {
			return fmt.Errorf("%w: event %d was recorded before undo existed", ErrInvalid, eventID)
		}
		cur, err := load(tx, taskID)
		if err != nil {
			return err
		}
		var newer bool
		if err := tx.QueryRowContext(bg,
			`SELECT EXISTS (SELECT 1 FROM task_events WHERE task_id = ? AND type = ? AND id > ?)`,
			taskID, EventTaskStateChanged, eventID).Scan(&newer); err != nil {
			return err
		}
		if newer || cur.State != p.To {
			return ErrUndoConflict
		}
		if _, err := tx.ExecContext(bg,
			`UPDATE tasks SET state = ?, started_at = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
			p.From, nullable(*p.PrevStartedAt), nullable(*p.PrevCompletedAt), now(), taskID); err != nil {
			return err
		}
		if err := undoCascadeTx(tx, p.Cascade); err != nil {
			return err
		}
		return deleteEvent(tx, eventID)
	})
	if err != nil {
		return err
	}
	afterUndo(conn)
	return nil
}

// UndoSubtaskCheck reverses the subtask_checked or subtask_unchecked event
// eventID of subtaskID, putting the checkbox back and deleting the event.
// It applies only while the event is the subtask's newest check event and
// the box still holds the event's value; otherwise ErrUndoConflict.
// ErrNotFound when the subtask (or its live task) or the event is missing;
// ErrInvalid when the event is not a check of this subtask. User or agent
// only.
func UndoSubtaskCheck(conn *sql.DB, a Actor, subtaskID, eventID int64) error {
	if err := validActor(a); err != nil {
		return err
	}
	err := inTx(conn, func(tx dbtx) error {
		s, err := loadSubtask(tx, subtaskID)
		if err != nil {
			return err
		}
		e, err := undoEventFor(tx, eventID, s.TaskID, EventSubtaskChecked, EventSubtaskUnchecked)
		if err != nil {
			return err
		}
		var p struct {
			SubtaskID int64 `json:"subtask_id"`
		}
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		if p.SubtaskID != subtaskID {
			return fmt.Errorf("%w: event %d is not subtask %d's", ErrInvalid, eventID, subtaskID)
		}
		var newer bool
		if err := tx.QueryRowContext(bg,
			`SELECT EXISTS (SELECT 1 FROM task_events
			                 WHERE task_id = ? AND type IN (?, ?) AND id > ?
			                   AND json_extract(payload, '$.subtask_id') = ?)`,
			s.TaskID, EventSubtaskChecked, EventSubtaskUnchecked, eventID, subtaskID).Scan(&newer); err != nil {
			return err
		}
		// The type says which way it went, for events recorded before the
		// payload carried from/to too.
		to := e.Type == EventSubtaskChecked
		if newer || s.Checked != to {
			return ErrUndoConflict
		}
		ts := now()
		if _, err := tx.ExecContext(bg, `UPDATE task_subtasks SET checked = ?, updated_at = ? WHERE id = ?`,
			bit(!to), ts, subtaskID); err != nil {
			return err
		}
		if err := touch(tx, s.TaskID, ts); err != nil {
			return err
		}
		return deleteEvent(tx, eventID)
	})
	if err != nil {
		return err
	}
	afterUndo(conn)
	return nil
}

// UndoDelete reverses the task_deleted event eventID of taskID: it clears
// deleted_at, reverses the cascade and deletes the events. It applies only
// while the task is still deleted by that event (its deleted_at is the
// event's timestamp, which Delete stamps both with); otherwise
// ErrUndoConflict. ErrNotFound when the task (purged) or event is missing;
// ErrInvalid when the event is not this task's delete. User or agent only.
func UndoDelete(conn *sql.DB, a Actor, taskID, eventID int64) error {
	if err := validActor(a); err != nil {
		return err
	}
	err := inTx(conn, func(tx dbtx) error {
		e, err := undoEventFor(tx, eventID, taskID, EventTaskDeleted)
		if err != nil {
			return err
		}
		var p deletePayload
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		var deleted sql.NullString
		err = tx.QueryRowContext(bg, `SELECT deleted_at FROM tasks WHERE id = ?`, taskID).Scan(&deleted)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if !deleted.Valid || deleted.String != e.TS {
			return ErrUndoConflict
		}
		if _, err := tx.ExecContext(bg, `UPDATE tasks SET deleted_at = NULL, updated_at = ? WHERE id = ?`,
			now(), taskID); err != nil {
			return err
		}
		if err := undoCascadeTx(tx, p.Cascade); err != nil {
			return err
		}
		return deleteEvent(tx, eventID)
	})
	if err != nil {
		return err
	}
	afterUndo(conn)
	return nil
}

// Undo reverses event eventID, whichever undoable kind it is (a state
// change, a subtask check or uncheck, a delete), as UndoStateChange,
// UndoSubtaskCheck or UndoDelete would. ErrInvalid for any other type.
// It is what the CLI's `tasks undo <event-id>` calls.
func Undo(conn *sql.DB, a Actor, eventID int64) error {
	if err := validActor(a); err != nil {
		return err
	}
	e, err := loadUndoEvent(conn, eventID)
	if err != nil {
		return err
	}
	switch e.Type {
	case EventTaskStateChanged:
		return UndoStateChange(conn, a, e.TaskID, eventID)
	case EventTaskDeleted:
		return UndoDelete(conn, a, e.TaskID, eventID)
	case EventSubtaskChecked, EventSubtaskUnchecked:
		var p struct {
			SubtaskID int64 `json:"subtask_id"`
		}
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		return UndoSubtaskCheck(conn, a, p.SubtaskID, eventID)
	}
	return fmt.Errorf("%w: event %d (%s) cannot be undone", ErrInvalid, eventID, e.Type)
}
