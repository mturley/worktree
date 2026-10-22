package tasks

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// maxSnapshotBody is the most runes of an event's body a snapshot keeps.
const maxSnapshotBody = 500

// EventSnapshot is what a linked event looked like when it was linked. A
// row renders from it once the live event is gone. The JSON tags are the
// wire form: the web layer serializes it directly.
type EventSnapshot struct {
	Source       string `json:"source"`
	Type         string `json:"type"`
	Title        string `json:"title"`
	Author       string `json:"author"`
	Body         string `json:"body"` // truncated to 500 runes on write
	URL          string `json:"url"`
	TS           string `json:"ts"`
	ResourceType string `json:"resource_type"`
	ResourceID   string `json:"resource_id"`
}

// EventLink is one activity event a task points at. Key is
// "ev:<watcher_events.id>" or "slack:<channel>:<message_ts>".
type EventLink struct {
	Key       string
	Snapshot  EventSnapshot
	CreatedAt string
}

func validEventKey(key string) error {
	if !strings.HasPrefix(key, "ev:") && !strings.HasPrefix(key, "slack:") {
		return fmt.Errorf("%w: event key %q does not start with %q or %q", ErrInvalid, key, "ev:", "slack:")
	}
	return nil
}

func eventLinkPayload(key, title string) map[string]any {
	return map[string]any{"key": key, "title": title}
}

// LinkEvent links taskID to the event identified by key, remembering snap.
// Linking an already-linked key changes nothing and records no event.
func LinkEvent(conn *sql.DB, a Actor, taskID int64, key string, snap EventSnapshot) error {
	return linkEvent(conn, a, taskID, key, snap, false)
}

// LinkEventReplace is LinkEvent, except that an already-linked key takes
// snap in place of the snapshot it had (recording no event). For a caller
// whose snapshot is authoritative: one the server built from the event
// itself beats one a client sent.
func LinkEventReplace(conn *sql.DB, a Actor, taskID int64, key string, snap EventSnapshot) error {
	return linkEvent(conn, a, taskID, key, snap, true)
}

func linkEvent(conn *sql.DB, a Actor, taskID int64, key string, snap EventSnapshot, replace bool) error {
	if err := validActor(a); err != nil {
		return err
	}
	raw, err := prepareEventLink(key, &snap)
	if err != nil {
		return err
	}
	return inTx(conn, func(tx dbtx) error {
		if _, err := load(tx, taskID); err != nil {
			return err
		}
		return linkEventTx(tx, a, taskID, key, snap.Title, raw, replace)
	})
}

// CreateFromEvent creates a task (as Create) with the event key linked (as
// LinkEvent), in one transaction: either both happen or neither does.
func CreateFromEvent(conn *sql.DB, a Actor, n NewTask, key string, snap EventSnapshot) (Task, error) {
	p, err := prepareNew(a, n)
	if err != nil {
		return Task{}, err
	}
	raw, err := prepareEventLink(key, &snap)
	if err != nil {
		return Task{}, err
	}
	var id int64
	err = inTx(conn, func(tx dbtx) error {
		if id, err = createTx(tx, a, p); err != nil {
			return err
		}
		return linkEventTx(tx, a, id, key, snap.Title, raw, false)
	})
	if err != nil {
		return Task{}, err
	}
	return Get(conn, id)
}

// prepareEventLink validates key, truncates snap's body and serializes it.
func prepareEventLink(key string, snap *EventSnapshot) (string, error) {
	if err := validEventKey(key); err != nil {
		return "", err
	}
	if r := []rune(snap.Body); len(r) > maxSnapshotBody {
		snap.Body = string(r[:maxSnapshotBody])
	}
	raw, err := json.Marshal(snap)
	return string(raw), err
}

// linkEventTx links key to taskID (a live task) inside an inTx body. It
// calls no public function. With replace, an existing link's snapshot
// becomes raw; one that already is raw writes nothing, so Version stays put.
func linkEventTx(tx dbtx, a Actor, taskID int64, key, title, raw string, replace bool) error {
	ts := now()
	res, err := tx.ExecContext(bg,
		`INSERT OR IGNORE INTO task_event_links (task_id, event_key, snapshot, created_at) VALUES (?, ?, ?, ?)`,
		taskID, key, raw, ts)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		if !replace {
			return nil
		}
		res, err := tx.ExecContext(bg,
			`UPDATE task_event_links SET snapshot = ? WHERE task_id = ? AND event_key = ? AND snapshot <> ?`,
			raw, taskID, key, raw)
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err != nil || n == 0 {
			return err
		}
		return touch(tx, taskID, ts)
	}
	if err := touch(tx, taskID, ts); err != nil {
		return err
	}
	_, err = record(tx, a, taskID, ts, EventTaskEventLinked, eventLinkPayload(key, title))
	return err
}

// UnlinkEvent removes taskID's link to key. A key that is not linked is
// ErrNotFound.
func UnlinkEvent(conn *sql.DB, a Actor, taskID int64, key string) error {
	if err := validActor(a); err != nil {
		return err
	}
	return inTx(conn, func(tx dbtx) error {
		if _, err := load(tx, taskID); err != nil {
			return err
		}
		var raw string
		err := tx.QueryRowContext(bg,
			`SELECT snapshot FROM task_event_links WHERE task_id = ? AND event_key = ?`, taskID, key).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("%w: event %q is not linked to task %d", ErrNotFound, key, taskID)
		}
		if err != nil {
			return err
		}
		var snap EventSnapshot
		_ = json.Unmarshal([]byte(raw), &snap) // the title is only for the event payload
		if _, err := tx.ExecContext(bg,
			`DELETE FROM task_event_links WHERE task_id = ? AND event_key = ?`, taskID, key); err != nil {
			return err
		}
		ts := now()
		if err := touch(tx, taskID, ts); err != nil {
			return err
		}
		_, err = record(tx, a, taskID, ts, EventTaskEventUnlinked, eventLinkPayload(key, snap.Title))
		return err
	})
}

// EventLinks returns taskID's linked events, oldest first.
func EventLinks(conn *sql.DB, taskID int64) ([]EventLink, error) {
	rows, err := conn.Query(
		`SELECT event_key, snapshot, created_at FROM task_event_links
		  WHERE task_id = ? ORDER BY created_at, rowid`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []EventLink
	for rows.Next() {
		var l EventLink
		var raw string
		if err := rows.Scan(&l.Key, &raw, &l.CreatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(raw), &l.Snapshot); err != nil {
			return nil, fmt.Errorf("event link %q of task %d: bad snapshot: %w", l.Key, taskID, err)
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// TasksLinkingEvent returns the IDs of the live tasks linked to key.
func TasksLinkingEvent(conn *sql.DB, key string) ([]int64, error) {
	rows, err := conn.Query(
		`SELECT l.task_id FROM task_event_links l JOIN tasks t ON t.id = l.task_id
		  WHERE l.event_key = ? AND t.deleted_at IS NULL ORDER BY l.task_id`, key)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
