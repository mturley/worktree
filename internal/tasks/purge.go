package tasks

import (
	"database/sql"
	"fmt"
	"time"
)

// PurgeDeleted permanently removes every soft-deleted task whose deleted_at
// is before cutoff, returning how many. Past that point an undo of the
// delete is no longer offered, so nothing needs the rows.
//
// Foreign keys are on, so a purged task's links, subtasks, event links and
// OWN blockers go with it by ON DELETE CASCADE. Not cascaded, and removed
// here: its task_events (deliberately no FK), its unread cursor
// (resource_read_cursor 'task' row) and its `task:<id>` hold subscriptions,
// live and tombstoned (a task id is never reused, AUTOINCREMENT, so a
// tombstone would serve nothing). Another task's blocker whose
// blocking_task_id names a purged task is untouched: that column has no FK,
// so the dangling id is kept and the UI labels it "T<id> (deleted)".
//
// It is one inTx, so a purge that removed anything bumps tasks_version.
func PurgeDeleted(conn *sql.DB, cutoff time.Time) (int, error) {
	cut := cutoff.UTC().Format(time.RFC3339)
	var purged int
	err := inTx(conn, func(tx dbtx) error {
		rows, err := tx.QueryContext(bg,
			`SELECT id FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < ?`, cut)
		if err != nil {
			return err
		}
		var ids []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, id := range ids {
			for _, q := range []string{
				`DELETE FROM task_events WHERE task_id = ?`,
				`DELETE FROM resource_read_cursor WHERE resource_type = 'task' AND resource_id = CAST(? AS TEXT)`,
				`DELETE FROM watcher_subscriptions WHERE subscriber = '` + holdPrefix + `' || CAST(? AS TEXT)`,
				`DELETE FROM tasks WHERE id = ?`,
			} {
				if _, err := tx.ExecContext(bg, q, id); err != nil {
					return fmt.Errorf("purge task %d: %w", id, err)
				}
			}
		}
		purged = len(ids)
		return nil
	})
	if err != nil {
		return 0, err
	}
	return purged, nil
}
