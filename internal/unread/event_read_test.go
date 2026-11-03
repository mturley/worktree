package unread_test

import (
	"errors"
	"testing"

	"github.com/mturley/worktree/internal/unread"
)

func TestMarkedEventLeavesTheCountsAndThroughTS(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "old", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	addEvent(t, conn, "e1", "2026-01-02T00:00:00Z", "pr", "o/r#1")
	addEvent(t, conn, "e2", "2026-01-03T00:00:00Z", "pr", "o/r#1")
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if err := unread.MarkEvent(conn, "e2", "2026-01-03T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	sums, err := unread.Summaries(conn)
	if err != nil {
		t.Fatal(err)
	}
	got := sums[unread.Key("pr", "o/r#1")]
	if got.Count != 1 || got.NewestTS != "2026-01-02T00:00:00Z" {
		t.Fatalf("summary = %+v, want the one unmarked event", got)
	}
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	if c := cursors[unread.Key("pr", "o/r#1")]; c != "2026-01-01T00:00:00Z" {
		t.Fatalf("cursor moved to %q", c)
	}
}

// The watcher rewrites a commit's CI row in place, type and ts: a new result
// on a row the user marked read is news.
func TestRewrittenEventComesBackUnread(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "ci", "2026-01-02T00:00:00Z", "pr", "o/r#1")
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if err := unread.MarkEvent(conn, "ci", "2026-01-02T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`UPDATE watcher_events SET ts='2026-01-05T00:00:00Z' WHERE id='ci'`); err != nil {
		t.Fatal(err)
	}
	sums, err := unread.Summaries(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := sums[unread.Key("pr", "o/r#1")].Count; n != 1 {
		t.Fatalf("count = %d, want the rewritten row unread again", n)
	}
}

func TestUnmarkEventRemovesOnlyTheMarkItNames(t *testing.T) {
	conn := openDB(t)
	if err := unread.MarkEvent(conn, "e1", "2026-01-02T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	// An undo of a mark on an older version of the row must not clear a newer mark.
	if removed, err := unread.UnmarkEvent(conn, "e1", "2026-01-01T00:00:00Z"); err != nil || removed {
		t.Fatalf("stale unmark: removed=%v err=%v", removed, err)
	}
	if removed, err := unread.UnmarkEvent(conn, "e1", "2026-01-02T00:00:00Z"); err != nil || !removed {
		t.Fatalf("unmark: removed=%v err=%v", removed, err)
	}
	marks, err := unread.EventMarks(conn)
	if err != nil {
		t.Fatal(err)
	}
	if len(marks) != 0 {
		t.Fatalf("marks = %v, want none", marks)
	}
}

func TestUnmarkEventWithoutTSRemovesWhateverIsThere(t *testing.T) {
	conn := openDB(t)
	if err := unread.MarkEvent(conn, "e1", "2026-01-02T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if removed, err := unread.UnmarkEvent(conn, "e1", ""); err != nil || !removed {
		t.Fatalf("removed=%v err=%v", removed, err)
	}
	if removed, err := unread.UnmarkEvent(conn, "e1", ""); err != nil || removed {
		t.Fatalf("second unmark: removed=%v err=%v", removed, err)
	}
}

func TestLoadEvent(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-02T00:00:00Z", "pr", "o/r#1")
	ev, err := unread.LoadEvent(conn, "e1")
	if err != nil {
		t.Fatal(err)
	}
	if ev.TS != "2026-01-02T00:00:00Z" || ev.Type != "pr_comment" || len(ev.Resources) != 1 || ev.Resources[0] != (unread.ResourceRef{Type: "pr", ID: "o/r#1"}) {
		t.Fatalf("event = %+v", ev)
	}
	if _, err := unread.LoadEvent(conn, "missing"); !errors.Is(err, unread.ErrEventNotFound) {
		t.Fatalf("missing: err = %v", err)
	}
	if _, err := unread.LoadEvent(conn, "task:999"); !errors.Is(err, unread.ErrEventNotFound) {
		t.Fatalf("missing task event: err = %v", err)
	}
}

func TestMarkedTaskEventLeavesTaskSummaries(t *testing.T) {
	conn := openDB(t)
	addTask(t, conn, 1, false)
	addTaskEvent(t, conn, 1, "2026-01-01T00:00:01Z", "agent")
	addTaskEvent(t, conn, 1, "2026-01-01T00:00:02Z", "agent")
	var newest int64
	if err := conn.QueryRow(`SELECT MAX(id) FROM task_events`).Scan(&newest); err != nil {
		t.Fatal(err)
	}
	if err := unread.MarkEvent(conn, unread.TaskEventID(newest), "2026-01-01T00:00:02Z"); err != nil {
		t.Fatal(err)
	}
	got, err := unread.TaskSummaries(conn)
	if err != nil {
		t.Fatal(err)
	}
	if s := got[1]; s.Count != 1 || s.NewestTS != "2026-01-01T00:00:01Z" {
		t.Fatalf("summary = %+v", s)
	}
}

func TestLoadTaskEvent(t *testing.T) {
	conn := openDB(t)
	addTask(t, conn, 7, false)
	addTask(t, conn, 8, true)
	addTaskEvent(t, conn, 7, "2026-01-01T00:00:01Z", "agent")
	addTaskEvent(t, conn, 8, "2026-01-01T00:00:01Z", "agent")
	rows, err := conn.Query(`SELECT id, task_id FROM task_events ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	ids := map[int64]int64{}
	for rows.Next() {
		var id, task int64
		if err := rows.Scan(&id, &task); err != nil {
			t.Fatal(err)
		}
		ids[task] = id
	}
	ev, err := unread.LoadEvent(conn, unread.TaskEventID(ids[7]))
	if err != nil {
		t.Fatal(err)
	}
	if ev.Source != "tasks" || ev.Actor != "agent" || ev.TS != "2026-01-01T00:00:01Z" || ev.TaskID != 7 {
		t.Fatalf("event = %+v", ev)
	}
	if _, err := unread.LoadEvent(conn, unread.TaskEventID(ids[8])); !errors.Is(err, unread.ErrEventNotFound) {
		t.Fatalf("deleted task's event: err = %v", err)
	}
}
