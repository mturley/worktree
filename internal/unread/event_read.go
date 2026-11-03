package unread

import (
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Single events marked read, on top of the per-resource cursor: an event is
// unread only if it is past the cursor AND has no mark here. The cursor never
// moves for a mark, so Mark all read still covers everything else, and
// restoring a cursor (its undo) leaves marks alone.
//
// A mark holds for the event's ts as well as its id. The watcher rewrites a
// commit's CI row in place, id unchanged and ts moved, and that new result is
// news: the stale mark stops matching and the row reads as unread again.
//
// Rows are never pruned once a cursor passes them. Undoing a Mark all read
// moves the cursor back, and the marks behind it must still hold.

// ErrEventNotFound: no watcher event, or no task event of a live task, by
// that id.
var ErrEventNotFound = errors.New("no such event")

// ErrEventChanged: the event's row has been rewritten since the caller saw it,
// so what they read is no longer what is there.
var ErrEventChanged = errors.New("event changed since it was shown")

// NotMarkedReadSQL is the condition "this event has no read mark", over a
// watcher_events row aliased e. Left out exactly like selfid.NotMineSQL:
// still rendered in the feeds, never counted or flagged unread.
const NotMarkedReadSQL = `NOT EXISTS (SELECT 1 FROM event_read m WHERE m.event_id = e.id AND m.event_ts = e.ts)`

// TaskNotMarkedReadSQL is NotMarkedReadSQL over a task_events row aliased e.
const TaskNotMarkedReadSQL = `NOT EXISTS (SELECT 1 FROM event_read m WHERE m.event_id = 'task:' || e.id AND m.event_ts = e.ts)`

const taskEventPrefix = "task:"

// TaskEventID is a task event's id as the feeds carry it and marks store it.
func TaskEventID(id int64) string {
	return taskEventPrefix + strconv.FormatInt(id, 10)
}

// EventMarks returns every mark: event id to the ts it was marked at.
func EventMarks(conn *sql.DB) (map[string]string, error) {
	rows, err := conn.Query(`SELECT event_id, event_ts FROM event_read`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, ts string
		if err := rows.Scan(&id, &ts); err != nil {
			return nil, err
		}
		out[id] = ts
	}
	return out, rows.Err()
}

// IsMarked is NotMarkedReadSQL's Go twin, negated, over EventMarks' result.
func IsMarked(marks map[string]string, eventID, ts string) bool {
	marked, ok := marks[eventID]
	return ok && marked == ts
}

// MarkEvent records that the event, as it stands at ts, has been read. A mark
// left from an older version of the row is replaced.
func MarkEvent(conn *sql.DB, eventID, ts string) error {
	_, err := conn.Exec(`
		INSERT INTO event_read (event_id, event_ts, read_at) VALUES (?, ?, ?)
		ON CONFLICT(event_id) DO UPDATE SET event_ts = excluded.event_ts, read_at = excluded.read_at`,
		eventID, ts, time.Now().UTC().Format(time.RFC3339))
	return err
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

// ResourceRef is one resource an event belongs to.
type ResourceRef struct{ Type, ID string }

// Event is what deciding an event's read state needs. A task event has Source
// "tasks", its TaskID and Actor, and no Resources.
type Event struct {
	ID, TS, ExternalTS, Type, Source, AuthorID string
	Resources                                  []ResourceRef
	TaskID                                     int64
	Actor                                      string
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
		SELECT ts, COALESCE(external_ts,''), type, source, COALESCE(author_id,'')
		  FROM watcher_events WHERE id = ?`, id).
		Scan(&ev.TS, &ev.ExternalTS, &ev.Type, &ev.Source, &ev.AuthorID)
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
