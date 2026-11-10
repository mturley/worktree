package tasks

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// MaxWorkLogText is the longest work log entry, in runes after trimming.
const MaxWorkLogText = 4000

// ErrNotWorkLog is returned when an event that is not a work log entry is
// passed to a work log operation.
var ErrNotWorkLog = fmt.Errorf("%w: not a work log entry", ErrInvalid)

// WorkLogPayload is the payload of a task_work_logged event.
type WorkLogPayload struct {
	Text     string `json:"text"`
	EditedAt string `json:"edited_at,omitempty"`
}

func cleanWorkLogText(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", fmt.Errorf("%w: work log text is empty", ErrInvalid)
	}
	if n := utf8.RuneCountInString(s); n > MaxWorkLogText {
		return "", fmt.Errorf("%w: work log text is %d characters, over the %d limit", ErrInvalid, n, MaxWorkLogText)
	}
	return s, nil
}

// loadWorkLog reads event id, requiring it to be a work log entry.
func loadWorkLog(q dbtx, id int64) (Event, error) {
	var e Event
	var payload string
	err := q.QueryRowContext(bg,
		`SELECT id, task_id, ts, type, actor, actor_session, payload FROM task_events WHERE id = ?`, id).
		Scan(&e.ID, &e.TaskID, &e.TS, &e.Type, &e.Actor, &e.ActorSession, &payload)
	if errors.Is(err, sql.ErrNoRows) {
		return Event{}, ErrNotFound
	}
	if err != nil {
		return Event{}, err
	}
	if e.Type != EventTaskWorkLogged {
		return Event{}, ErrNotWorkLog
	}
	e.Payload = json.RawMessage(payload)
	return e, nil
}

// LogWork records a work log entry on a live task and returns the event.
func LogWork(conn *sql.DB, a Actor, taskID int64, text string) (Event, error) {
	if err := validActor(a); err != nil {
		return Event{}, err
	}
	text, err := cleanWorkLogText(text)
	if err != nil {
		return Event{}, err
	}
	var ev Event
	err = inTx(conn, func(tx dbtx) error {
		if _, err := load(tx, taskID); err != nil {
			return err
		}
		ts := now()
		id, err := record(tx, a, taskID, ts, EventTaskWorkLogged, WorkLogPayload{Text: text})
		if err != nil {
			return err
		}
		if err := touch(tx, taskID, ts); err != nil {
			return err
		}
		ev, err = loadWorkLog(tx, id)
		return err
	})
	if err != nil {
		return Event{}, err
	}
	return ev, nil
}

// EditWorkLog changes a work log entry's text, stamping edited_at. The
// event's id and ts are unchanged. Identical text writes nothing.
func EditWorkLog(conn *sql.DB, a Actor, eventID int64, text string) (Event, error) {
	if err := validActor(a); err != nil {
		return Event{}, err
	}
	text, err := cleanWorkLogText(text)
	if err != nil {
		return Event{}, err
	}
	var ev Event
	err = inTx(conn, func(tx dbtx) error {
		cur, err := loadWorkLog(tx, eventID)
		if err != nil {
			return err
		}
		ev = cur
		var p WorkLogPayload
		if err := json.Unmarshal(cur.Payload, &p); err != nil {
			return err
		}
		if p.Text == text {
			return nil
		}
		ts := now()
		p.Text, p.EditedAt = text, ts
		b, err := json.Marshal(p)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(bg, `UPDATE task_events SET payload = ? WHERE id = ?`, string(b), eventID); err != nil {
			return err
		}
		ev.Payload = json.RawMessage(b)
		return touch(tx, cur.TaskID, ts)
	})
	if err != nil {
		return Event{}, err
	}
	return ev, nil
}

// DeleteWorkLog removes a work log entry and returns its task's id.
func DeleteWorkLog(conn *sql.DB, a Actor, eventID int64) (int64, error) {
	if err := validActor(a); err != nil {
		return 0, err
	}
	var taskID int64
	err := inTx(conn, func(tx dbtx) error {
		cur, err := loadWorkLog(tx, eventID)
		if err != nil {
			return err
		}
		taskID = cur.TaskID
		if _, err := tx.ExecContext(bg, `DELETE FROM task_events WHERE id = ?`, eventID); err != nil {
			return err
		}
		return touch(tx, taskID, now())
	})
	if err != nil {
		return 0, err
	}
	return taskID, nil
}

// WorkLogTaskID returns the task a work log entry belongs to: ErrNotFound
// when there is no such event, ErrNotWorkLog when it is another type.
func WorkLogTaskID(conn *sql.DB, eventID int64) (int64, error) {
	e, err := loadWorkLog(conn, eventID)
	if err != nil {
		return 0, err
	}
	return e.TaskID, nil
}
