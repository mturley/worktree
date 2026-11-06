package unread

import (
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Single events marked read or unread, overriding the per-resource cursor in
// either direction:
//
//	no mark          unread when past the cursor
//	StateRead        never unread
//	StateUnread      always unread, even behind the cursor or with no cursor
//
// The cursor never moves for a mark, and a mark that would only repeat the
// cursor's verdict is not stored. A mark holds for the event's ts as well as
// its id: the watcher rewrites a commit's CI row in place, id unchanged and ts
// moved, and a mark on the old result says nothing about the new one.
//
// Moving a cursor (Mark) clears the unread marks at or before its through_ts,
// because Mark all read has to clear them: when the only unread event is an old
// marked one, its through_ts is behind the cursor and the cursor cannot move.
// Read marks are never cleared. Undoing a Mark all read moves the cursor back,
// and the marks behind it must still hold.

// The states a mark can hold.
const (
	StateRead   = "read"
	StateUnread = "unread"
)

// EventMark is one event's mark: the ts it was made at, and its state.
type EventMark struct{ TS, State string }

// ClearedMark is an unread mark a cursor move removed, for its undo.
type ClearedMark struct {
	ID string `json:"id"`
	TS string `json:"ts"`
}

// ErrEventNotFound: no watcher event, or no task event of a live task, by
// that id.
var ErrEventNotFound = errors.New("no such event")

// ErrEventChanged: the event's row has been rewritten since the caller saw it,
// so what they read is no longer what is there.
var ErrEventChanged = errors.New("event changed since it was shown")

// ErrNeverUnread: the event can never read as unread, so marking it so would
// promise something no count or feed will show. The user's own events, CI runs
// in progress and the bookkeeping events no feed renders.
var ErrNeverUnread = errors.New("this event can never be unread")

// ErrNotFollowed: no worktree follows the event's resource, so there is no card
// to show the unread on or clear it from.
var ErrNotFollowed = errors.New("no worktree follows this event's resource")

// The conditions over a watcher_events row aliased e. A read-marked event is
// left out exactly like selfid.NotMineSQL: still rendered in the feeds, never
// counted or flagged unread.
const (
	NotMarkedReadSQL = `NOT EXISTS (SELECT 1 FROM event_read m WHERE m.event_id = e.id AND m.event_ts = e.ts AND m.state = 'read')`
	MarkedUnreadSQL  = `EXISTS (SELECT 1 FROM event_read m WHERE m.event_id = e.id AND m.event_ts = e.ts AND m.state = 'unread')`
)

// The same over a task_events row aliased e.
const (
	TaskNotMarkedReadSQL = `NOT EXISTS (SELECT 1 FROM event_read m WHERE m.event_id = 'task:' || e.id AND m.event_ts = e.ts AND m.state = 'read')`
	TaskMarkedUnreadSQL  = `EXISTS (SELECT 1 FROM event_read m WHERE m.event_id = 'task:' || e.id AND m.event_ts = e.ts AND m.state = 'unread')`
)

const taskEventPrefix = "task:"

// TaskEventID is a task event's id as the feeds carry it and marks store it.
func TaskEventID(id int64) string {
	return taskEventPrefix + strconv.FormatInt(id, 10)
}

// EventMarks returns every mark, by event id.
func EventMarks(conn *sql.DB) (map[string]EventMark, error) {
	rows, err := conn.Query(`SELECT event_id, event_ts, state FROM event_read`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]EventMark{}
	for rows.Next() {
		var id string
		var m EventMark
		if err := rows.Scan(&id, &m.TS, &m.State); err != nil {
			return nil, err
		}
		out[id] = m
	}
	return out, rows.Err()
}

// EventUnread is the rule, in Go: a mark at the event's current ts decides, and
// otherwise pastCursor does. The SQL twins are NotMarkedReadSQL and
// MarkedUnreadSQL, combined as (past cursor AND not marked read) OR marked
// unread.
func EventUnread(marks map[string]EventMark, eventID, ts string, pastCursor bool) bool {
	if m, ok := marks[eventID]; ok && m.TS == ts {
		return m.State == StateUnread
	}
	return pastCursor
}

// SetEventMark records the event, as it stands at ts, as read or unread. A mark
// left from an older version of the row is replaced.
func SetEventMark(conn *sql.DB, eventID, ts, state string) error {
	_, err := conn.Exec(`
		INSERT INTO event_read (event_id, event_ts, read_at, state) VALUES (?, ?, ?, ?)
		ON CONFLICT(event_id) DO UPDATE SET
			event_ts = excluded.event_ts, read_at = excluded.read_at, state = excluded.state`,
		eventID, ts, time.Now().UTC().Format(time.RFC3339), state)
	return err
}

// RestoreEventMark undoes a mark write, given the row version it was made at
// and the state it replaced ("" for no mark). Aimed at an older version of the
// row it changes nothing, so it cannot clear or overwrite a newer mark.
func RestoreEventMark(conn *sql.DB, eventID, ts, previous string) error {
	if previous == "" {
		_, err := UnmarkEvent(conn, eventID, ts)
		return err
	}
	_, err := conn.Exec(`
		INSERT INTO event_read (event_id, event_ts, read_at, state) VALUES (?, ?, ?, ?)
		ON CONFLICT(event_id) DO UPDATE SET read_at = excluded.read_at, state = excluded.state
		 WHERE event_read.event_ts = excluded.event_ts`,
		eventID, ts, time.Now().UTC().Format(time.RFC3339), previous)
	return err
}

// clearUnreadMarks removes the resource's unread marks at or before throughTS,
// answering them for an undo. Marks newer than it stay, under the same rule as
// the cursor: what the client was not shown stays unread.
func clearUnreadMarks(tx *sql.Tx, resType, id, throughTS string) ([]ClearedMark, error) {
	query := `
		SELECT m.event_id, m.event_ts FROM event_read m
		  JOIN watcher_event_resources er ON er.event_id = m.event_id
		 WHERE m.state = 'unread' AND m.event_ts <= ?
		   AND er.resource_type = ? AND er.resource_id = ?`
	args := []any{throughTS, resType, id}
	if resType == "task" {
		query = `
			SELECT m.event_id, m.event_ts FROM event_read m
			  JOIN task_events e ON m.event_id = 'task:' || e.id
			 WHERE m.state = 'unread' AND m.event_ts <= ?
			   AND e.task_id = ?`
		args = []any{throughTS, id}
	}
	rows, err := tx.Query(query, args...)
	if err != nil {
		return nil, err
	}
	var out []ClearedMark
	for rows.Next() {
		var c ClearedMark
		if err := rows.Scan(&c.ID, &c.TS); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, c := range out {
		if _, err := tx.Exec(`DELETE FROM event_read WHERE event_id = ?`, c.ID); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// restoreUnreadMarks puts back what clearUnreadMarks removed. A mark made on the
// event since then stays: it is newer than the one being restored.
func restoreUnreadMarks(tx *sql.Tx, cleared []ClearedMark) error {
	now := time.Now().UTC().Format(time.RFC3339)
	for _, c := range cleared {
		if _, err := tx.Exec(`
			INSERT INTO event_read (event_id, event_ts, read_at, state) VALUES (?, ?, ?, 'unread')
			ON CONFLICT(event_id) DO NOTHING`, c.ID, c.TS, now); err != nil {
			return err
		}
	}
	return nil
}

// UnmarkEvent takes a mark back, reporting whether there was one to remove.
// With a ts it removes only the mark at that ts, so undoing a mark on an older
// version of a row cannot clear one made on the newer version. An empty ts
// removes whatever is there.
func UnmarkEvent(conn *sql.DB, eventID, ts string) (bool, error) {
	query, args := `DELETE FROM event_read WHERE event_id = ?`, []any{eventID}
	if ts != "" {
		query += ` AND event_ts = ?`
		args = append(args, ts)
	}
	res, err := conn.Exec(query, args...)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// IsFollowed reports whether a live worktree follows any of the event's
// resources. Holds a task keeps on a resource do not count, nor do tombstones.
func IsFollowed(conn *sql.DB, ev Event) (bool, error) {
	for _, r := range ev.Resources {
		var n int
		if err := conn.QueryRow(`
			SELECT COUNT(*) FROM watcher_subscriptions
			 WHERE resource_type = ? AND resource_id = ?
			   AND subscriber LIKE 'worktree:%' AND deleted_at IS NULL`, r.Type, r.ID).Scan(&n); err != nil {
			return false, err
		}
		if n > 0 {
			return true, nil
		}
	}
	return false, nil
}

// ResourceRef is one resource an event belongs to.
type ResourceRef struct{ Type, ID string }

// Event is what deciding an event's read state needs. A task event has Source
// "tasks", its TaskID and Actor, and no Resources.
type Event struct {
	ID, TS, ExternalTS, Type, Source, AuthorID, AuthorType string
	Resources                                              []ResourceRef
	TaskID                                                 int64
	Actor                                                  string
}

// IsSlack reports whether the event's read state is Slack's.
func (e Event) IsSlack() bool {
	if e.Source == "slack" {
		return true
	}
	for _, r := range e.Resources {
		if r.Type == "slack" {
			return true
		}
	}
	return false
}

// LoadEvent reads one event by the id the feeds carry, watcher or task.
// ErrEventNotFound when there is none, or it belongs to a deleted task.
func LoadEvent(conn *sql.DB, id string) (Event, error) {
	if num, ok := strings.CutPrefix(id, taskEventPrefix); ok {
		return loadTaskEvent(conn, id, num)
	}
	ev := Event{ID: id}
	err := conn.QueryRow(`
		SELECT ts, COALESCE(external_ts,''), type, source, COALESCE(author_id,''), COALESCE(author_type,'')
		  FROM watcher_events WHERE id = ?`, id).
		Scan(&ev.TS, &ev.ExternalTS, &ev.Type, &ev.Source, &ev.AuthorID, &ev.AuthorType)
	if errors.Is(err, sql.ErrNoRows) {
		return Event{}, ErrEventNotFound
	}
	if err != nil {
		return Event{}, err
	}
	rows, err := conn.Query(`SELECT resource_type, resource_id FROM watcher_event_resources WHERE event_id = ?`, id)
	if err != nil {
		return Event{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var r ResourceRef
		if err := rows.Scan(&r.Type, &r.ID); err != nil {
			return Event{}, err
		}
		ev.Resources = append(ev.Resources, r)
	}
	return ev, rows.Err()
}

func loadTaskEvent(conn *sql.DB, id, num string) (Event, error) {
	ev := Event{ID: id, Source: "tasks"}
	err := conn.QueryRow(`
		SELECT e.ts, e.type, e.actor, e.task_id
		  FROM task_events e JOIN tasks t ON t.id = e.task_id AND t.deleted_at IS NULL
		 WHERE e.id = ?`, num).
		Scan(&ev.TS, &ev.Type, &ev.Actor, &ev.TaskID)
	if errors.Is(err, sql.ErrNoRows) {
		return Event{}, ErrEventNotFound
	}
	return ev, err
}
