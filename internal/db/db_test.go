package db

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenAtCreatesTables(t *testing.T) {
	p := filepath.Join(t.TempDir(), "worktree.db")
	conn, err := OpenAt(p)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer conn.Close()

	for _, tbl := range []string{"watcher_subscriptions", "worktree_primary", "port_allocations", "worktrees", "resource_read_cursor", "worktree_notes", "review_comments"} {
		var name string
		err := conn.QueryRow(
			`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, tbl).Scan(&name)
		if err != nil {
			t.Fatalf("expected table %q to exist: %v", tbl, err)
		}
	}
}

// The activity feeds read task_events across tasks by ts (tasks.FeedEvents),
// and the notifier and Load more page on it, so it needs its own index.
func TestOpenAtCreatesTaskEventsTSIndex(t *testing.T) {
	conn, err := OpenAt(filepath.Join(t.TempDir(), "worktree.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var sqlText string
	if err := conn.QueryRow(`SELECT sql FROM sqlite_master WHERE type='index' AND name='task_events_ts'`).Scan(&sqlText); err != nil {
		t.Fatalf("expected index task_events_ts: %v", err)
	}
	if want := "ON task_events (ts, id)"; !strings.Contains(sqlText, want) {
		t.Errorf("index sql = %q, want it to contain %q", sqlText, want)
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

// hasColumn reports whether tbl has a column named col.
func hasColumn(t *testing.T, conn *sql.DB, tbl, col string) bool {
	t.Helper()
	rows, err := conn.Query(`SELECT name FROM pragma_table_info(?)`, tbl)
	if err != nil {
		t.Fatalf("pragma_table_info(%s): %v", tbl, err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		if name == col {
			return true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return false
}

func TestOpenAtAddsSortOrderToExistingPrimaryTable(t *testing.T) {
	p := filepath.Join(t.TempDir(), "worktree.db")

	// Stand up a pre-sort_order database by hand, with a row in it, so the
	// migration is exercised as an upgrade rather than a fresh create.
	raw, err := sql.Open("sqlite", p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`CREATE TABLE worktree_primary (
		subscriber    TEXT NOT NULL,
		resource_type TEXT NOT NULL,
		resource_id   TEXT NOT NULL,
		is_primary    INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (subscriber, resource_type, resource_id)
	)`); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(
		`INSERT INTO worktree_primary VALUES ('worktree:/a', 'pr', 'o/r#1', 1)`); err != nil {
		t.Fatal(err)
	}
	raw.Close()

	conn, err := OpenAt(p)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer conn.Close()

	if !hasColumn(t, conn, "worktree_primary", "sort_order") {
		t.Fatal("expected worktree_primary.sort_order after migrating an older database")
	}

	// The upgrade must not disturb the classification already stored.
	var isPrimary int
	var sortOrder sql.NullInt64
	if err := conn.QueryRow(
		`SELECT is_primary, sort_order FROM worktree_primary WHERE resource_id = 'o/r#1'`,
	).Scan(&isPrimary, &sortOrder); err != nil {
		t.Fatal(err)
	}
	if isPrimary != 1 {
		t.Fatalf("is_primary = %d, want 1", isPrimary)
	}
	if sortOrder.Valid {
		t.Fatalf("sort_order = %v, want NULL for a row that predates ordering", sortOrder)
	}
}

// Only state-like task changes are task events. migrate deletes every row of
// the types no longer recorded, keeps the rest, and a second run changes
// nothing.
func TestMigrateDeletesDroppedTaskEventTypes(t *testing.T) {
	conn, err := OpenAt(filepath.Join(t.TempDir(), "worktree.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	dropped := []string{
		"task_edited", "task_linked", "task_unlinked", "task_focus_changed",
		"subtask_added", "subtask_edited", "subtask_removed",
		"task_event_linked", "task_event_unlinked",
		"task_blocker_added", "task_blocker_removed",
	}
	insert := func(typ string) {
		t.Helper()
		if _, err := conn.Exec(`INSERT INTO task_events (task_id, ts, type, actor, actor_session, payload)
			VALUES (1, '2026-01-01T00:00:00Z', ?, 'user', '', '{}')`, typ); err != nil {
			t.Fatal(err)
		}
	}
	for _, typ := range dropped {
		insert(typ)
	}
	insert("task_state_changed")

	types := func() []string {
		t.Helper()
		rows, err := conn.Query(`SELECT type FROM task_events ORDER BY id`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var s string
			if err := rows.Scan(&s); err != nil {
				t.Fatal(err)
			}
			out = append(out, s)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return out
	}

	if err := migrate(conn); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if got := types(); len(got) != 1 || got[0] != "task_state_changed" {
		t.Fatalf("after migrate, task_events types = %v, want [task_state_changed]", got)
	}
	if err := migrate(conn); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	if got := types(); len(got) != 1 || got[0] != "task_state_changed" {
		t.Fatalf("after second migrate, task_events types = %v, want [task_state_changed]", got)
	}
}

func TestOpenAtAddsGitHubColumnsToReviewComments(t *testing.T) {
	p := filepath.Join(t.TempDir(), "worktree.db")
	// A review_comments table from before comments were sent to GitHub.
	raw, err := sql.Open("sqlite", p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`CREATE TABLE review_comments (
		id INTEGER PRIMARY KEY AUTOINCREMENT, worktree TEXT NOT NULL, file TEXT NOT NULL,
		side TEXT NOT NULL CHECK (side IN ('old','new')), start_line INTEGER NOT NULL,
		end_line INTEGER NOT NULL, rev TEXT NOT NULL, base TEXT NOT NULL, base_ref TEXT NOT NULL,
		range_from TEXT NOT NULL DEFAULT '', range_to TEXT NOT NULL DEFAULT '',
		snippet TEXT NOT NULL, context_before TEXT NOT NULL, context_after TEXT NOT NULL,
		body TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'draft',
		version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	raw.Close()
	conn, err := OpenAt(p)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer conn.Close()
	for _, col := range []string{"github_comment_id", "github_sent_version"} {
		if !hasColumn(t, conn, "review_comments", col) {
			t.Fatalf("expected review_comments.%s after migrating", col)
		}
	}
}
