package tasks

import (
	"database/sql"
	"testing"
	"time"
)

// deleteAgo soft-deletes task id and backdates deleted_at by age.
func deleteAgo(t *testing.T, conn *sql.DB, id int64, age time.Duration) {
	t.Helper()
	if _, err := Delete(conn, user, id); err != nil {
		t.Fatal(err)
	}
	ts := time.Now().UTC().Add(-age).Format(time.RFC3339)
	if _, err := conn.Exec(`UPDATE tasks SET deleted_at = ? WHERE id = ?`, ts, id); err != nil {
		t.Fatal(err)
	}
}

func rowCount(t *testing.T, conn *sql.DB, q string, args ...any) int {
	t.Helper()
	var n int
	if err := conn.QueryRow(q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPurgeDeletedRemovesOldTaskAndChildren(t *testing.T) {
	conn := newDB(t)
	old := mustCreate(t, conn, "old")
	if _, err := conn.Exec(`INSERT INTO task_subtasks (task_id, text, position, created_at, updated_at) VALUES (?, 'step', 0, 'x', 'x')`, old.ID); err != nil {
		t.Fatal(err)
	}
	mustAddBlocker(t, conn, old.ID, resTarget("pr", "o/r#1"))
	if _, err := conn.Exec(`INSERT INTO resource_read_cursor (resource_type, resource_id, last_read_ts, updated_at) VALUES ('task', ?, 'x', 'x')`, old.ID); err != nil {
		t.Fatal(err)
	}
	deleteAgo(t, conn, old.ID, 2*time.Hour)
	// Delete releases the hold (tombstone); the row must still be there to purge.
	if c := rowCount(t, conn, `SELECT COUNT(*) FROM watcher_subscriptions WHERE subscriber = ?`, HoldSubscriber(old.ID)); c == 0 {
		t.Fatal("setup: expected a hold tombstone")
	}

	v0, _ := Version(conn)
	n, err := PurgeDeleted(conn, time.Now().Add(-time.Hour))
	if err != nil || n != 1 {
		t.Fatalf("PurgeDeleted = %d, %v", n, err)
	}
	for _, q := range []string{
		`SELECT COUNT(*) FROM tasks WHERE id = ?`,
		`SELECT COUNT(*) FROM task_subtasks WHERE task_id = ?`,
		`SELECT COUNT(*) FROM task_blockers WHERE task_id = ?`,
		`SELECT COUNT(*) FROM task_events WHERE task_id = ?`,
		`SELECT COUNT(*) FROM resource_read_cursor WHERE resource_type = 'task' AND resource_id = CAST(? AS TEXT)`,
	} {
		if c := rowCount(t, conn, q, old.ID); c != 0 {
			t.Errorf("%s left %d rows", q, c)
		}
	}
	if c := rowCount(t, conn, `SELECT COUNT(*) FROM watcher_subscriptions WHERE subscriber = ?`, HoldSubscriber(old.ID)); c != 0 {
		t.Errorf("hold rows left: %d", c)
	}
	if v1, _ := Version(conn); v1 <= v0 {
		t.Errorf("version not bumped: %d -> %d", v0, v1)
	}
	// Nothing left: a second sweep removes nothing and does not bump.
	v1, _ := Version(conn)
	if n, err := PurgeDeleted(conn, time.Now().Add(-time.Hour)); err != nil || n != 0 {
		t.Fatalf("second PurgeDeleted = %d, %v", n, err)
	}
	if v2, _ := Version(conn); v2 != v1 {
		t.Errorf("no-op sweep bumped version")
	}
}

func TestPurgeDeletedKeepsRecentAndLive(t *testing.T) {
	conn := newDB(t)
	recent := mustCreate(t, conn, "recent")
	live := mustCreate(t, conn, "live")
	deleteAgo(t, conn, recent.ID, 5*time.Minute)
	if n, err := PurgeDeleted(conn, time.Now().Add(-time.Hour)); err != nil || n != 0 {
		t.Fatalf("PurgeDeleted = %d, %v", n, err)
	}
	if c := rowCount(t, conn, `SELECT COUNT(*) FROM tasks WHERE id IN (?, ?)`, recent.ID, live.ID); c != 2 {
		t.Fatalf("tasks left = %d, want 2", c)
	}
}

func TestPurgeDeletedKeepsUndeletedTask(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "back")
	deleteAgo(t, conn, tk.ID, 2*time.Hour)
	// Undone before the sweep: undo clears deleted_at.
	if _, err := conn.Exec(`UPDATE tasks SET deleted_at = NULL WHERE id = ?`, tk.ID); err != nil {
		t.Fatal(err)
	}
	if n, err := PurgeDeleted(conn, time.Now().Add(-time.Hour)); err != nil || n != 0 {
		t.Fatalf("PurgeDeleted = %d, %v", n, err)
	}
	if _, err := Get(conn, tk.ID); err != nil {
		t.Fatalf("Get: %v", err)
	}
}

func TestPurgeDeletedKeepsOtherTasksBlockerOnIt(t *testing.T) {
	conn := newDB(t)
	gone := mustCreate(t, conn, "gone")
	other := mustCreate(t, conn, "other")
	b := mustAddBlocker(t, conn, other.ID, taskTarget(gone.ID))
	deleteAgo(t, conn, gone.ID, 2*time.Hour)
	if n, err := PurgeDeleted(conn, time.Now().Add(-time.Hour)); err != nil || n != 1 {
		t.Fatalf("PurgeDeleted = %d, %v", n, err)
	}
	var blocking int64
	if err := conn.QueryRow(`SELECT blocking_task_id FROM task_blockers WHERE id = ?`, b.ID).Scan(&blocking); err != nil || blocking != gone.ID {
		t.Fatalf("blocker row: blocking=%d err=%v", blocking, err)
	}
}

// Purging task 1 removes only task:1's holds: task 12's "task:12" shares
// the prefix but must survive.
func TestPurgeDeletedKeepsHoldOfTaskWithSharedIDPrefix(t *testing.T) {
	conn := newDB(t)
	var one, twelve Task
	for i := 1; i <= 12; i++ {
		tk := mustCreate(t, conn, "t")
		switch tk.ID {
		case 1:
			one = tk
		case 12:
			twelve = tk
		}
	}
	if one.ID != 1 || twelve.ID != 12 {
		t.Fatalf("setup: ids %d and %d", one.ID, twelve.ID)
	}
	mustAddBlocker(t, conn, one.ID, resTarget("pr", "o/r#1"))
	mustAddBlocker(t, conn, twelve.ID, resTarget("pr", "o/r#12"))
	const live = `SELECT COUNT(*) FROM watcher_subscriptions WHERE subscriber = ? AND deleted_at IS NULL`
	if c := rowCount(t, conn, live, HoldSubscriber(twelve.ID)); c != 1 {
		t.Fatalf("setup: task 12 has %d live holds, want 1", c)
	}
	deleteAgo(t, conn, one.ID, 2*time.Hour)
	if n, err := PurgeDeleted(conn, time.Now().Add(-time.Hour)); err != nil || n != 1 {
		t.Fatalf("PurgeDeleted = %d, %v", n, err)
	}
	if c := rowCount(t, conn, `SELECT COUNT(*) FROM watcher_subscriptions WHERE subscriber = ?`, HoldSubscriber(one.ID)); c != 0 {
		t.Errorf("task 1's hold rows left: %d", c)
	}
	if c := rowCount(t, conn, live, HoldSubscriber(twelve.ID)); c != 1 {
		t.Errorf("task 12's live holds after purging task 1 = %d, want 1", c)
	}
}
