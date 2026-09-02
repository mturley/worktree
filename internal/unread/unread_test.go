package unread_test

import (
	"database/sql"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/unread"
)

func openDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// addEvent inserts one event linked to one resource, at the given ts.
func addEvent(t *testing.T, conn *sql.DB, id, ts, resType, resID string) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO watcher_events (id, ts, source, type, title) VALUES (?, ?, 'github', 'pr_comment', 'x')`,
		id, ts); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id) VALUES (?, ?, ?)`,
		id, resType, resID); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureCursorSeedsAtNewestEvent(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	addEvent(t, conn, "e2", "2026-01-02T00:00:00Z", "pr", "o/r#1")

	if err := unread.EnsureCursor(conn, "pr", "o/r#1"); err != nil {
		t.Fatal(err)
	}
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	if got := cursors[unread.Key("pr", "o/r#1")]; got != "2026-01-02T00:00:00Z" {
		t.Fatalf("cursor = %q, want the newest event's ts", got)
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#1")]; n != 0 {
		t.Fatalf("unread = %d, want 0 — a freshly seeded resource starts read", n)
	}
}

func TestEnsureCursorDoesNotResetAnExistingCursor(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	if err := unread.EnsureCursor(conn, "pr", "o/r#1"); err != nil {
		t.Fatal(err)
	}
	// New activity arrives, then a SECOND worktree subscribes to the same
	// resource. Its EnsureCursor must not swallow the unread event.
	addEvent(t, conn, "e2", "2026-01-02T00:00:00Z", "pr", "o/r#1")
	if err := unread.EnsureCursor(conn, "pr", "o/r#1"); err != nil {
		t.Fatal(err)
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#1")]; n != 1 {
		t.Fatalf("unread = %d, want 1 — a second subscriber inherits the cursor", n)
	}
}

func TestEnsureCursorSkipsSlack(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "slack", "C1:1.2")
	if err := unread.EnsureCursor(conn, "slack", "C1:1.2"); err != nil {
		t.Fatalf("EnsureCursor must be a silent no-op for slack, got %v", err)
	}
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := cursors[unread.Key("slack", "C1:1.2")]; ok {
		t.Fatal("a slack thread must never get a cursor row")
	}
}

func TestCountsIsStrictlyGreaterThanCursor(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	addEvent(t, conn, "e2", "2026-01-02T00:00:00Z", "pr", "o/r#1")
	addEvent(t, conn, "e3", "2026-01-03T00:00:00Z", "pr", "o/r#1")
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2026-01-02T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	// e2 is AT the cursor and counts as read; only e3 is newer.
	if n := counts[unread.Key("pr", "o/r#1")]; n != 1 {
		t.Fatalf("unread = %d, want 1", n)
	}
}

func TestCountsIgnoresResourcesWithNoCursor(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "pr", "o/r#9")
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#9")]; n != 0 {
		t.Fatalf("unread = %d, want 0 — a missing cursor row reads as nothing unread", n)
	}
}

func TestMarkReadOnlyMovesForward(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	addEvent(t, conn, "e2", "2026-01-05T00:00:00Z", "pr", "o/r#1")
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2026-01-05T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	// A stale client replays an older through_ts; the cursor must not rewind.
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	if got := cursors[unread.Key("pr", "o/r#1")]; got != "2026-01-05T00:00:00Z" {
		t.Fatalf("cursor = %q, want it to stay at the newer ts", got)
	}
}

func TestMarkReadRejectsSlack(t *testing.T) {
	conn := openDB(t)
	if err := unread.MarkRead(conn, "slack", "C1:1.2", "1.0"); err == nil {
		t.Fatal("MarkRead must reject a slack resource")
	}
}

func TestMarkReadCreatesACursorForAnUnseededResource(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "jira", "J-1")
	if err := unread.MarkRead(conn, "jira", "J-1", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	if got := cursors[unread.Key("jira", "J-1")]; got != "2026-01-01T00:00:00Z" {
		t.Fatalf("cursor = %q, want the marked ts", got)
	}
}
