package tasks

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// Subtask is one checkbox item on a task.
type Subtask struct {
	ID, TaskID int64
	Text       string
	Checked    bool
	Position   int
}

// SubtaskChange reports what SetSubtaskChecked did. EventID is 0 when the
// subtask already had the requested value.
type SubtaskChange struct {
	From, To bool
	EventID  int64
}

func cleanSubtaskText(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", fmt.Errorf("%w: subtask text is empty", ErrInvalid)
	}
	return s, nil
}

// loadSubtask reads a subtask whose parent task is live; otherwise it
// returns ErrNotFound.
func loadSubtask(tx dbtx, id int64) (Subtask, error) {
	var s Subtask
	var checked int
	err := tx.QueryRowContext(bg,
		`SELECT s.id, s.task_id, s.text, s.checked, s.position
		   FROM task_subtasks s JOIN tasks t ON t.id = s.task_id
		  WHERE s.id = ? AND t.deleted_at IS NULL`, id).Scan(&s.ID, &s.TaskID, &s.Text, &checked, &s.Position)
	if errors.Is(err, sql.ErrNoRows) {
		return Subtask{}, ErrNotFound
	}
	if err != nil {
		return Subtask{}, err
	}
	s.Checked = checked != 0
	return s, nil
}

// subtaskPayload identifies a subtask in a subtask_checked/unchecked payload.
func subtaskPayload(s Subtask) map[string]any {
	return map[string]any{"subtask_id": s.ID, "text": s.Text}
}

// AddSubtask appends a subtask to the end of a task's list.
func AddSubtask(conn *sql.DB, a Actor, taskID int64, text string) (Subtask, error) {
	if err := validActor(a); err != nil {
		return Subtask{}, err
	}
	text, err := cleanSubtaskText(text)
	if err != nil {
		return Subtask{}, err
	}
	var s Subtask
	err = inTx(conn, func(tx dbtx) error {
		if _, err := load(tx, taskID); err != nil {
			return err
		}
		var last sql.NullInt64
		if err := tx.QueryRowContext(bg, `SELECT MAX(position) FROM task_subtasks WHERE task_id = ?`, taskID).Scan(&last); err != nil {
			return err
		}
		pos := 0
		if last.Valid {
			pos = int(last.Int64) + 1
		}
		ts := now()
		res, err := tx.ExecContext(bg,
			`INSERT INTO task_subtasks (task_id, text, checked, position, created_at, updated_at)
			 VALUES (?, ?, 0, ?, ?, ?)`, taskID, text, pos, ts, ts)
		if err != nil {
			return err
		}
		id, err := res.LastInsertId()
		if err != nil {
			return err
		}
		s = Subtask{ID: id, TaskID: taskID, Text: text, Position: pos}
		return touch(tx, taskID, ts)
	})
	if err != nil {
		return Subtask{}, err
	}
	return s, nil
}

// EditSubtask changes a subtask's text. Unchanged text writes nothing.
func EditSubtask(conn *sql.DB, a Actor, id int64, text string) error {
	if err := validActor(a); err != nil {
		return err
	}
	text, err := cleanSubtaskText(text)
	if err != nil {
		return err
	}
	return inTx(conn, func(tx dbtx) error {
		cur, err := loadSubtask(tx, id)
		if err != nil {
			return err
		}
		if cur.Text == text {
			return nil
		}
		ts := now()
		if _, err := tx.ExecContext(bg, `UPDATE task_subtasks SET text = ?, updated_at = ? WHERE id = ?`, text, ts, id); err != nil {
			return err
		}
		return touch(tx, cur.TaskID, ts)
	})
}

// SetSubtaskChecked sets a subtask's checkbox, recording subtask_checked or
// subtask_unchecked {subtask_id, text, from, to}. Setting the current value
// changes nothing and returns EventID 0; otherwise EventID is what
// UndoSubtaskCheck takes.
func SetSubtaskChecked(conn *sql.DB, a Actor, id int64, checked bool) (SubtaskChange, error) {
	if err := validActor(a); err != nil {
		return SubtaskChange{}, err
	}
	var sc SubtaskChange
	err := inTx(conn, func(tx dbtx) error {
		cur, err := loadSubtask(tx, id)
		if err != nil {
			return err
		}
		sc = SubtaskChange{From: cur.Checked, To: checked}
		if cur.Checked == checked {
			return nil
		}
		ts := now()
		if _, err := tx.ExecContext(bg, `UPDATE task_subtasks SET checked = ?, updated_at = ? WHERE id = ?`, bit(checked), ts, id); err != nil {
			return err
		}
		if err := touch(tx, cur.TaskID, ts); err != nil {
			return err
		}
		typ := EventSubtaskUnchecked
		if checked {
			typ = EventSubtaskChecked
		}
		p := subtaskPayload(cur)
		p["from"], p["to"] = cur.Checked, checked
		sc.EventID, err = record(tx, a, cur.TaskID, ts, typ, p)
		return err
	})
	if err != nil {
		return SubtaskChange{}, err
	}
	return sc, nil
}

// SubtaskTaskID returns the ID of the live task subtask id belongs to, or
// ErrNotFound when the subtask is missing or its task is deleted.
func SubtaskTaskID(conn *sql.DB, id int64) (int64, error) {
	s, err := loadSubtask(conn, id)
	if err != nil {
		return 0, err
	}
	return s.TaskID, nil
}

// RemoveSubtask deletes a subtask.
func RemoveSubtask(conn *sql.DB, a Actor, id int64) error {
	if err := validActor(a); err != nil {
		return err
	}
	return inTx(conn, func(tx dbtx) error {
		cur, err := loadSubtask(tx, id)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(bg, `DELETE FROM task_subtasks WHERE id = ?`, id); err != nil {
			return err
		}
		return touch(tx, cur.TaskID, now())
	})
}

// SetSubtaskOrder reorders a task's subtasks declaratively: ids not
// belonging to the task are ignored (and repeats collapse), subtasks left
// out keep their relative order after the listed ones. It records no event
// and, like moving a task, leaves the task's updated_at alone.
func SetSubtaskOrder(conn *sql.DB, taskID int64, ids []int64) error {
	return inTx(conn, func(tx dbtx) error {
		if _, err := load(tx, taskID); err != nil {
			return err
		}
		rows, err := tx.QueryContext(bg, `SELECT id FROM task_subtasks WHERE task_id = ? ORDER BY position, id`, taskID)
		if err != nil {
			return err
		}
		var existing []int64
		own := map[int64]bool{}
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			existing = append(existing, id)
			own[id] = true
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()

		placed := map[int64]bool{}
		var order []int64
		for _, id := range ids {
			if own[id] && !placed[id] {
				placed[id] = true
				order = append(order, id)
			}
		}
		for _, id := range existing {
			if !placed[id] {
				order = append(order, id)
			}
		}
		for i, id := range order {
			if _, err := tx.ExecContext(bg, `UPDATE task_subtasks SET position = ? WHERE id = ?`, i, id); err != nil {
				return err
			}
		}
		return nil
	})
}

// loadSubtasks reads the subtasks of every live task (or just onlyID's),
// keyed by task, ordered by position then id.
func loadSubtasks(q dbtx, onlyID *int64) (map[int64][]Subtask, error) {
	query := `SELECT s.id, s.task_id, s.text, s.checked, s.position
	            FROM task_subtasks s JOIN tasks t ON t.id = s.task_id
	           WHERE t.deleted_at IS NULL`
	var args []any
	if onlyID != nil {
		query += ` AND s.task_id = ?`
		args = append(args, *onlyID)
	}
	rows, err := q.QueryContext(bg, query+` ORDER BY s.task_id, s.position, s.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][]Subtask{}
	for rows.Next() {
		var s Subtask
		var checked int
		if err := rows.Scan(&s.ID, &s.TaskID, &s.Text, &checked, &s.Position); err != nil {
			return nil, err
		}
		s.Checked = checked != 0
		out[s.TaskID] = append(out[s.TaskID], s)
	}
	return out, rows.Err()
}
