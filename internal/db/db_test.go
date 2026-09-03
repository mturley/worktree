package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestOpenAtCreatesTables(t *testing.T) {
	p := filepath.Join(t.TempDir(), "worktree.db")
	conn, err := OpenAt(p)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer conn.Close()

	for _, tbl := range []string{"watcher_subscriptions", "worktree_primary", "port_allocations", "worktrees", "resource_read_cursor"} {
		var name string
		err := conn.QueryRow(
			`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, tbl).Scan(&name)
		if err != nil {
			t.Fatalf("expected table %q to exist: %v", tbl, err)
		}
	}
}

func TestOpenAtIdempotent(t *testing.T) {
	p := filepath.Join(t.TempDir(), "worktree.db")
	c1, err := OpenAt(p)
	if err != nil {
		t.Fatal(err)
	}
	c1.Close()
	c2, err := OpenAt(p) // second open must not error on existing tables
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}
	c2.Close()
}

func TestPathResolution(t *testing.T) {
	t.Run("WORKTREE_DB override wins", func(t *testing.T) {
		override := "/custom/path/worktree.db"
		t.Setenv("WORKTREE_DB", override)
		t.Setenv("XDG_DATA_HOME", "/should/be/ignored")

		got, err := Path()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != override {
			t.Fatalf("got %q, want %q", got, override)
		}
	})

	t.Run("XDG_DATA_HOME used when WORKTREE_DB unset", func(t *testing.T) {
		t.Setenv("WORKTREE_DB", "")
		xdg := "/xdg/data/home"
		t.Setenv("XDG_DATA_HOME", xdg)

		got, err := Path()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := filepath.Join(xdg, "worktree", "worktree.db")
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})

	t.Run("falls back to HOME/.local/share when both unset", func(t *testing.T) {
		t.Setenv("WORKTREE_DB", "")
		t.Setenv("XDG_DATA_HOME", "")
		home := t.TempDir()
		t.Setenv("HOME", home)

		got, err := Path()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := filepath.Join(home, ".local", "share", "worktree", "worktree.db")
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})
}

// seedSub inserts a subscription row directly, the way an already-installed
// DB looks before the read-cursor migration first runs.
func seedSub(t *testing.T, conn *sql.DB, id, resType, resID, deletedAt string) {
	t.Helper()
	var del any
	if deletedAt != "" {
		del = deletedAt
	}
	if _, err := conn.Exec(
		`INSERT INTO watcher_subscriptions
		   (id, subscriber, resource_type, resource_id, created_at, deleted_at)
		 VALUES (?, 'worktree:/tmp/wt', ?, ?, '2026-01-01T00:00:00Z', ?)`,
		id, resType, resID, del); err != nil {
		t.Fatal(err)
	}
}

func seedDBEvent(t *testing.T, conn *sql.DB, id, ts, resType, resID string) {
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

// cursorFor returns the stored cursor and whether a row exists.
func cursorFor(t *testing.T, conn *sql.DB, resType, resID string) (string, bool) {
	t.Helper()
	var ts string
	err := conn.QueryRow(
		`SELECT last_read_ts FROM resource_read_cursor WHERE resource_type = ? AND resource_id = ?`,
		resType, resID).Scan(&ts)
	if err == sql.ErrNoRows {
		return "", false
	}
	if err != nil {
		t.Fatal(err)
	}
	return ts, true
}

// The backfill is the only code in this package that runs unconditionally
// against the user's live DB on every open, so its behaviour is pinned here
// rather than left to inspection.
func TestMigrateBackfillsExistingResources(t *testing.T) {
	conn, err := OpenAt(filepath.Join(t.TempDir(), "worktree.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	seedSub(t, conn, "s1", "pr", "o/r#1", "")
	seedSub(t, conn, "s2", "jira", "J-1", "")
	seedSub(t, conn, "s3", "slack", "C1:1.2", "")
	seedSub(t, conn, "s4", "pr", "o/r#9", "2026-02-01T00:00:00Z") // soft-deleted
	seedDBEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	seedDBEvent(t, conn, "e2", "2026-01-03T00:00:00Z", "pr", "o/r#1")
	seedDBEvent(t, conn, "e3", "2026-01-02T00:00:00Z", "jira", "J-1")
	seedDBEvent(t, conn, "e4", "2026-01-04T00:00:00Z", "slack", "C1:1.2")
	seedDBEvent(t, conn, "e5", "2026-01-05T00:00:00Z", "pr", "o/r#9")

	if err := migrate(conn); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// Existing pr/jira resources land at their newest event, so the feature
	// goes live silent instead of announcing a backlog.
	if got, ok := cursorFor(t, conn, "pr", "o/r#1"); !ok || got != "2026-01-03T00:00:00Z" {
		t.Fatalf("pr cursor = %q (present=%v), want the newest event's ts", got, ok)
	}
	if got, ok := cursorFor(t, conn, "jira", "J-1"); !ok || got != "2026-01-02T00:00:00Z" {
		t.Fatalf("jira cursor = %q (present=%v), want the newest event's ts", got, ok)
	}
	// Slack keeps its own read state and must never get a cursor row.
	if _, ok := cursorFor(t, conn, "slack", "C1:1.2"); ok {
		t.Fatal("slack must never be seeded a read cursor")
	}
	// A soft-deleted subscription is not tracked any more; seeding it would
	// resurrect a row nothing cleans up.
	if _, ok := cursorFor(t, conn, "pr", "o/r#9"); ok {
		t.Fatal("soft-deleted subscriptions must not be seeded")
	}
}

func TestMigrateBackfillIsIdempotent(t *testing.T) {
	conn, err := OpenAt(filepath.Join(t.TempDir(), "worktree.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	seedSub(t, conn, "s1", "pr", "o/r#1", "")
	seedDBEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	if err := migrate(conn); err != nil {
		t.Fatal(err)
	}

	var before int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM resource_read_cursor`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(conn); err != nil {
		t.Fatal(err)
	}
	var after int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM resource_read_cursor`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("cursor rows %d -> %d; a re-run must insert nothing new", before, after)
	}
}

// The backfill runs on EVERY open, so it must not keep re-seeding a resource
// at its newest event — that would silently swallow anything that arrived
// since the last open.
func TestMigrateBackfillDoesNotSwallowEventsBetweenOpens(t *testing.T) {
	conn, err := OpenAt(filepath.Join(t.TempDir(), "worktree.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	seedSub(t, conn, "s1", "pr", "o/r#1", "")
	seedDBEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	if err := migrate(conn); err != nil {
		t.Fatal(err)
	}

	// An event arrives, then the user opens worktree again.
	seedDBEvent(t, conn, "e2", "2026-01-02T00:00:00Z", "pr", "o/r#1")
	if err := migrate(conn); err != nil {
		t.Fatal(err)
	}

	got, ok := cursorFor(t, conn, "pr", "o/r#1")
	if !ok {
		t.Fatal("cursor disappeared")
	}
	if got != "2026-01-01T00:00:00Z" {
		t.Fatalf("cursor = %q, want it left at the first open's ts so e2 stays unread", got)
	}
}
