package tasks

import (
	"database/sql"
	"encoding/json"
)

// Event types written to task_events. Reordering tasks or subtasks writes no
// event: it is noise in a feed.
const (
	EventTaskCreated       = "task_created"
	EventTaskEdited        = "task_edited"        // {"changes":{"<field>":{"from":…,"to":…}}}
	EventTaskStateChanged  = "task_state_changed" // {"from":…,"to":…}
	EventTaskDeleted       = "task_deleted"
	EventTaskLinked        = "task_linked"
	EventTaskUnlinked      = "task_unlinked"
	EventTaskFocusChanged  = "task_focus_changed"
	EventSubtaskAdded      = "subtask_added"
	EventSubtaskEdited     = "subtask_edited"
	EventSubtaskChecked    = "subtask_checked"
	EventSubtaskUnchecked  = "subtask_unchecked"
	EventSubtaskRemoved    = "subtask_removed"
	EventTaskEventLinked   = "task_event_linked"   // {"key","title"}
	EventTaskEventUnlinked = "task_event_unlinked" // {"key","title"}
	// Blocker events. Every payload has {"blocker_id","kind","label"};
	// resolved adds "auto" and "reason". Automatic ones use ActorSystem.
	EventTaskBlockerAdded      = "task_blocker_added"
	EventTaskBlockerRemoved    = "task_blocker_removed"
	EventTaskBlockerResolved   = "task_blocker_resolved"
	EventTaskBlockerUnresolved = "task_blocker_unresolved"
)

// Event is one row of a task's history.
type Event struct {
	ID, TaskID   int64
	TS           string // RFC3339 UTC
	Type         string
	Actor        string // ActorUser, ActorAgent or ActorSystem
	ActorSession string // "" when unknown
	Payload      json.RawMessage
}

// change is one field's before and after in a task_edited payload.
type change struct {
	From any `json:"from"`
	To   any `json:"to"`
}

// record writes one event inside tx, stamped with ts, and returns its ID. A
// nil payload is stored as {}.
func record(tx dbtx, a Actor, taskID int64, ts, typ string, payload any) (int64, error) {
	if err := validInternalActor(a); err != nil {
		return 0, err
	}
	body := []byte("{}")
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return 0, err
		}
		body = b
	}
	res, err := tx.ExecContext(bg,
		`INSERT INTO task_events (task_id, ts, type, actor, actor_session, payload)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		taskID, ts, typ, a.Kind, a.Session, string(body))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// Events returns taskID's history, newest first. Events outlive the task, so
// this works for a deleted task too.
func Events(conn *sql.DB, taskID int64) ([]Event, error) {
	rows, err := conn.Query(
		`SELECT id, task_id, ts, type, actor, actor_session, payload
		   FROM task_events WHERE task_id = ?
		  ORDER BY ts DESC, id DESC`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Event
	for rows.Next() {
		var e Event
		var payload string
		if err := rows.Scan(&e.ID, &e.TaskID, &e.TS, &e.Type, &e.Actor, &e.ActorSession, &payload); err != nil {
			return nil, err
		}
		e.Payload = json.RawMessage(payload)
		out = append(out, e)
	}
	return out, rows.Err()
}
