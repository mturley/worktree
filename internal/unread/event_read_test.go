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
	if err := unread.SetEventMark(conn, "e2", "2026-01-03T00:00:00Z", unread.StateRead); err != nil {
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
	if err := unread.SetEventMark(conn, "ci", "2026-01-02T00:00:00Z", unread.StateRead); err != nil {
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
	if err := unread.SetEventMark(conn, "e1", "2026-01-02T00:00:00Z", unread.StateRead); err != nil {
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
	if err := unread.SetEventMark(conn, "e1", "2026-01-02T00:00:00Z", unread.StateRead); err != nil {
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
	if err := unread.SetEventMark(conn, unread.TaskEventID(newest), "2026-01-01T00:00:02Z", unread.StateRead); err != nil {
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

func TestUnreadMarkCountsAnEventBehindTheCursor(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "old", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	addEvent(t, conn, "older", "2025-12-01T00:00:00Z", "pr", "o/r#1")
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if err := unread.SetEventMark(conn, "older", "2025-12-01T00:00:00Z", unread.StateUnread); err != nil {
		t.Fatal(err)
	}
	sums, err := unread.Summaries(conn)
	if err != nil {
		t.Fatal(err)
	}
	if got := sums[unread.Key("pr", "o/r#1")]; got.Count != 1 || got.NewestTS != "2025-12-01T00:00:00Z" {
		t.Fatalf("summary = %+v", got)
	}
}

// No cursor row reads as read, but an explicit unread mark still counts.
func TestUnreadMarkCountsWithoutACursorRow(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "j1", "2026-01-01T00:00:00Z", "jira", "J-1")
	addEvent(t, conn, "j2", "2026-01-02T00:00:00Z", "jira", "J-1")
	if err := unread.SetEventMark(conn, "j1", "2026-01-01T00:00:00Z", unread.StateUnread); err != nil {
		t.Fatal(err)
	}
	sums, err := unread.Summaries(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := sums[unread.Key("jira", "J-1")].Count; n != 1 {
		t.Fatalf("count = %d, want only the marked event", n)
	}
}

func TestEventUnreadVerdict(t *testing.T) {
	marks := map[string]unread.EventMark{
		"r": {TS: "t1", State: unread.StateRead},
		"u": {TS: "t1", State: unread.StateUnread},
	}
	for _, c := range []struct {
		id, ts string
		past   bool
		want   bool
	}{
		{"none", "t1", true, true},
		{"none", "t1", false, false},
		{"r", "t1", true, false},
		{"u", "t1", false, true},
		{"r", "t2", true, true},   // rewritten: the read mark no longer holds
		{"u", "t2", false, false}, // rewritten: nor does the unread one
	} {
		if got := unread.EventUnread(marks, c.id, c.ts, c.past); got != c.want {
			t.Errorf("%s at %s past=%v: %v, want %v", c.id, c.ts, c.past, got, c.want)
		}
	}
}

// Mark all read on a resource whose only unread is an old marked event: the
// through-ts is behind the cursor, so only clearing the mark can clear it.
func TestMarkClearsUnreadMarksAndRestorePutsThemBack(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "old", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	addEvent(t, conn, "older", "2025-12-01T00:00:00Z", "pr", "o/r#1")
	addEvent(t, conn, "other", "2025-12-01T00:00:00Z", "pr", "o/r#2")
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if err := unread.MarkRead(conn, "pr", "o/r#2", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"older", "other"} {
		if err := unread.SetEventMark(conn, id, "2025-12-01T00:00:00Z", unread.StateUnread); err != nil {
			t.Fatal(err)
		}
	}

	ch, err := unread.Mark(conn, "pr", "o/r#1", "2025-12-01T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if *ch.Previous != ch.Current {
		t.Fatalf("cursor moved: %+v", ch)
	}
	if len(ch.ClearedUnread) != 1 || ch.ClearedUnread[0] != (unread.ClearedMark{ID: "older", TS: "2025-12-01T00:00:00Z"}) {
		t.Fatalf("cleared = %+v", ch.ClearedUnread)
	}
	sums, err := unread.Summaries(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := sums[unread.Key("pr", "o/r#1")].Count; n != 0 {
		t.Fatalf("count after mark = %d", n)
	}
	if n := sums[unread.Key("pr", "o/r#2")].Count; n != 1 {
		t.Fatalf("another resource's mark was touched: count %d", n)
	}

	if err := unread.Restore(conn, "pr", "o/r#1", ch.Current, ch.Previous, ch.ClearedUnread...); err != nil {
		t.Fatal(err)
	}
	sums, err = unread.Summaries(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := sums[unread.Key("pr", "o/r#1")].Count; n != 1 {
		t.Fatalf("count after restore = %d", n)
	}
}

// Everything the client was not shown stays unread: the same through_ts rule
// as the cursor.
func TestMarkKeepsUnreadMarksNewerThanThroughTS(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	addEvent(t, conn, "e2", "2026-01-03T00:00:00Z", "pr", "o/r#1")
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2026-01-05T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if err := unread.SetEventMark(conn, "e2", "2026-01-03T00:00:00Z", unread.StateUnread); err != nil {
		t.Fatal(err)
	}
	ch, err := unread.Mark(conn, "pr", "o/r#1", "2026-01-02T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if len(ch.ClearedUnread) != 0 {
		t.Fatalf("cleared = %+v", ch.ClearedUnread)
	}
}

// A refused restore changes nothing, marks included.
func TestRestoreLeavesMarksWhenTheCursorMoved(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2026-01-05T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if err := unread.SetEventMark(conn, "e1", "2026-01-01T00:00:00Z", unread.StateUnread); err != nil {
		t.Fatal(err)
	}
	ch, err := unread.Mark(conn, "pr", "o/r#1", "2026-01-06T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2026-01-07T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if err := unread.Restore(conn, "pr", "o/r#1", ch.Current, ch.Previous, ch.ClearedUnread...); !errors.Is(err, unread.ErrCursorMoved) {
		t.Fatalf("err = %v", err)
	}
	marks, err := unread.EventMarks(conn)
	if err != nil {
		t.Fatal(err)
	}
	if len(marks) != 0 {
		t.Fatalf("marks = %+v", marks)
	}
}

func TestTaskUnreadMarkBehindTheCursor(t *testing.T) {
	conn := openDB(t)
	addTask(t, conn, 1, false)
	addTaskEvent(t, conn, 1, "2026-01-01T00:00:01Z", "agent")
	addTaskEvent(t, conn, 1, "2026-01-01T00:00:02Z", "agent")
	if err := unread.MarkRead(conn, "task", "1", "2026-01-01T00:00:02Z"); err != nil {
		t.Fatal(err)
	}
	var oldest int64
	if err := conn.QueryRow(`SELECT MIN(id) FROM task_events`).Scan(&oldest); err != nil {
		t.Fatal(err)
	}
	if err := unread.SetEventMark(conn, unread.TaskEventID(oldest), "2026-01-01T00:00:01Z", unread.StateUnread); err != nil {
		t.Fatal(err)
	}
	got, err := unread.TaskSummaries(conn)
	if err != nil {
		t.Fatal(err)
	}
	if s := got[1]; s.Count != 1 || s.NewestTS != "2026-01-01T00:00:01Z" {
		t.Fatalf("summary = %+v", s)
	}
	ch, err := unread.Mark(conn, "task", "1", "2026-01-01T00:00:01Z")
	if err != nil {
		t.Fatal(err)
	}
	if len(ch.ClearedUnread) != 1 {
		t.Fatalf("cleared = %+v", ch.ClearedUnread)
	}
	if got, _ := unread.TaskSummaries(conn); got[1].Count != 0 {
		t.Fatalf("after mark: %+v", got[1])
	}
}

func TestRestoreEventMark(t *testing.T) {
	conn := openDB(t)
	const ts = "2026-01-02T00:00:00Z"
	// Back to no mark, only at the ts it was made.
	if err := unread.SetEventMark(conn, "e1", ts, unread.StateUnread); err != nil {
		t.Fatal(err)
	}
	if err := unread.RestoreEventMark(conn, "e1", "2026-01-01T00:00:00Z", ""); err != nil {
		t.Fatal(err)
	}
	if marks, _ := unread.EventMarks(conn); len(marks) != 1 {
		t.Fatalf("stale restore removed the mark: %+v", marks)
	}
	if err := unread.RestoreEventMark(conn, "e1", ts, ""); err != nil {
		t.Fatal(err)
	}
	if marks, _ := unread.EventMarks(conn); len(marks) != 0 {
		t.Fatalf("marks = %+v", marks)
	}
	// Back to a mark the write replaced or deleted.
	if err := unread.RestoreEventMark(conn, "e1", ts, unread.StateRead); err != nil {
		t.Fatal(err)
	}
	marks, _ := unread.EventMarks(conn)
	if marks["e1"] != (unread.EventMark{TS: ts, State: unread.StateRead}) {
		t.Fatalf("marks = %+v", marks)
	}
	// A restore aimed at an older version of the row leaves a newer mark.
	const newer = "2026-01-05T00:00:00Z"
	if err := unread.SetEventMark(conn, "e1", newer, unread.StateUnread); err != nil {
		t.Fatal(err)
	}
	if err := unread.RestoreEventMark(conn, "e1", ts, unread.StateRead); err != nil {
		t.Fatal(err)
	}
	marks, _ = unread.EventMarks(conn)
	if marks["e1"] != (unread.EventMark{TS: newer, State: unread.StateUnread}) {
		t.Fatalf("marks = %+v", marks)
	}
}
