package tasks

import (
	"database/sql"
	"encoding/json"
	"strings"
)

// FeedQuery selects task events across tasks, for the activity feeds.
type FeedQuery struct {
	TaskIDs   []int64 // nil = every non-deleted task; empty non-nil = none
	Before    string  // exclusive ts cursor; "" = newest
	Limit     int     // <= 0 = no limit
	AgentOnly bool    // only actor = 'agent'
	SinceTS   string  // inclusive lower bound; "" = none (for unread)
}

// FeedEvent is a task event with its task's current title.
type FeedEvent struct {
	Event
	TaskTitle string
}

// FeedEvents returns the events q selects, newest first (ts DESC, id DESC).
// Events of soft-deleted tasks are always excluded, even when named in
// q.TaskIDs; Events (by task) is the way to read a deleted task's history.
func FeedEvents(conn *sql.DB, q FeedQuery) ([]FeedEvent, error) {
	if q.TaskIDs != nil && len(q.TaskIDs) == 0 {
		return []FeedEvent{}, nil
	}
	query := `SELECT e.id, e.task_id, e.ts, e.type, e.actor, e.actor_session, e.payload, t.title
	            FROM task_events e JOIN tasks t ON t.id = e.task_id
	           WHERE t.deleted_at IS NULL`
	var args []any
	if q.TaskIDs != nil {
		marks := make([]string, len(q.TaskIDs))
		for i, id := range q.TaskIDs {
			marks[i] = "?"
			args = append(args, id)
		}
		query += ` AND e.task_id IN (` + strings.Join(marks, ",") + `)`
	}
	if q.Before != "" {
		query += ` AND e.ts < ?`
		args = append(args, q.Before)
	}
	if q.SinceTS != "" {
		query += ` AND e.ts >= ?`
		args = append(args, q.SinceTS)
	}
	if q.AgentOnly {
		query += ` AND e.actor = 'agent'`
	}
	query += ` ORDER BY e.ts DESC, e.id DESC`
	if q.Limit > 0 {
		query += ` LIMIT ?`
		args = append(args, q.Limit)
	}
	rows, err := conn.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FeedEvent{}
	for rows.Next() {
		var e FeedEvent
		var payload string
		if err := rows.Scan(&e.ID, &e.TaskID, &e.TS, &e.Type, &e.Actor, &e.ActorSession, &payload, &e.TaskTitle); err != nil {
			return nil, err
		}
		e.Payload = json.RawMessage(payload)
		out = append(out, e)
	}
	return out, rows.Err()
}

// ScopeTaskIDs returns the ids of the tasks a feed for scope s covers: List's
// membership with completed and archived tasks included. ScopeAll returns
// nil, which FeedQuery reads as "every non-deleted task". Any other scope
// returns a non-nil slice, empty when no task is in it.
func ScopeTaskIDs(conn *sql.DB, s Scope) ([]int64, error) {
	if s.Kind == "" || s.Kind == ScopeAll {
		return nil, nil
	}
	ts, err := List(conn, Filter{Scope: s, IncludeCompleted: true, IncludeArchived: true})
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(ts))
	for _, t := range ts {
		ids = append(ids, t.ID)
	}
	return ids, nil
}
