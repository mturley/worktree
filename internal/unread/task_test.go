package unread_test

import (
	"database/sql"
	"errors"
	"fmt"
	"testing"

	"github.com/mturley/worktree/internal/unread"
)

// addTask inserts a task row. Plain SQL: unread must not import
// internal/tasks.
func addTask(t *testing.T, conn *sql.DB, id int, deleted bool) {
	t.Helper()
	del := "NULL"
	if deleted {
		del = "'2026-01-01T00:00:00Z'"
	}
	if _, err := conn.Exec(`INSERT INTO tasks (id, title, rank, created_at, updated_at, deleted_at)
		VALUES (?, 't', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', `+del+`)`,
		id, fmt.Sprintf("r%03d", id)); err != nil {
		t.Fatal(err)
	}
}

func addTaskEvent(t *testing.T, conn *sql.DB, task int, ts, actor string) {
	t.Helper()
	if _, err := conn.Exec(`INSERT INTO task_events (task_id, ts, type, actor, actor_session, payload)
		VALUES (?, ?, 'task_edited', ?, '', '{}')`, task, ts, actor); err != nil {
		t.Fatal(err)
	}
}

func TestTaskSummaries(t *testing.T) {
	conn := openDB(t)
	addTask(t, conn, 1, false) // cursor set
	addTask(t, conn, 2, false) // no cursor row
	addTask(t, conn, 3, true)  // deleted
	addTask(t, conn, 4, false) // only user events
	addTaskEvent(t, conn, 1, "2026-01-01T00:00:01Z", "agent")
	addTaskEvent(t, conn, 1, "2026-01-01T00:00:02Z", "agent")
	addTaskEvent(t, conn, 1, "2026-01-01T00:00:03Z", "agent")
	addTaskEvent(t, conn, 1, "2026-01-01T00:00:04Z", "user")
	addTaskEvent(t, conn, 2, "2026-01-01T00:00:01Z", "agent")
	addTaskEvent(t, conn, 2, "2026-01-01T00:00:05Z", "agent")
	addTaskEvent(t, conn, 3, "2026-01-01T00:00:01Z", "agent")
	addTaskEvent(t, conn, 4, "2026-01-01T00:00:01Z", "user")
	if _, err := unread.Mark(conn, "task", "1", "2026-01-01T00:00:01Z"); err != nil {
		t.Fatal(err)
	}

	got, err := unread.TaskSummaries(conn)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("summaries %+v", got)
	}
	if s := got[1]; s.Count != 2 || s.NewestTS != "2026-01-01T00:00:03Z" {
		t.Fatalf("task 1 = %+v", s)
	}
	if s := got[2]; s.Count != 2 || s.NewestTS != "2026-01-01T00:00:05Z" {
		t.Fatalf("task 2 = %+v", s)
	}
}

func TestMarkAndRestoreTask(t *testing.T) {
	conn := openDB(t)
	addTask(t, conn, 5, false)
	addTaskEvent(t, conn, 5, "2026-01-01T00:00:01Z", "agent")
	ch, err := unread.Mark(conn, "task", "5", "2026-01-01T00:00:01Z")
	if err != nil {
		t.Fatal(err)
	}
	if ch.Previous != nil || ch.Current != "2026-01-01T00:00:01Z" {
		t.Fatalf("change %+v", ch)
	}
	if s, _ := unread.TaskSummaries(conn); len(s) != 0 {
		t.Fatalf("after mark %+v", s)
	}
	if err := unread.Restore(conn, "task", "5", ch.Current, ch.Previous); err != nil {
		t.Fatal(err)
	}
	if s, _ := unread.TaskSummaries(conn); s[5].Count != 1 {
		t.Fatalf("after restore %+v", s)
	}
	// 409 path: the cursor moved on after the mark being undone.
	ch, _ = unread.Mark(conn, "task", "5", "2026-01-01T00:00:01Z")
	if _, err := unread.Mark(conn, "task", "5", "2026-01-01T00:00:09Z"); err != nil {
		t.Fatal(err)
	}
	if err := unread.Restore(conn, "task", "5", ch.Current, ch.Previous); !errors.Is(err, unread.ErrCursorMoved) {
		t.Fatalf("err = %v, want ErrCursorMoved", err)
	}
}
