package db

import (
	"database/sql"
	"time"
)

// migrate creates the worktree-owned tables. It is idempotent and disjoint
// from the watcher library's Migrate (which owns all watcher_* tables). None
// of these table names use the watcher_ prefix, so the library's collision
// check never flags them.
func migrate(conn *sql.DB) error {
	stmts := []string{
		// primary/related flag the library schema does not carry.
		// Keyed by (subscriber, resource) so it composes with watcher_subscriptions.
		`CREATE TABLE IF NOT EXISTS worktree_primary (
			subscriber    TEXT NOT NULL,
			resource_type TEXT NOT NULL,
			resource_id   TEXT NOT NULL,
			is_primary    INTEGER NOT NULL DEFAULT 0,
			sort_order    INTEGER,
			PRIMARY KEY (subscriber, resource_type, resource_id)
		)`,
		// port allocations: one slot per name, unique slot for atomic allocate.
		`CREATE TABLE IF NOT EXISTS port_allocations (
			name TEXT PRIMARY KEY,
			slot INTEGER NOT NULL UNIQUE
		)`,
		// worktree registry: replaces filesystem discovery.
		`CREATE TABLE IF NOT EXISTS worktrees (
			path       TEXT PRIMARY KEY,
			repo       TEXT NOT NULL,
			repo_root  TEXT NOT NULL,
			branch     TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		// Per-resource read cursor. Worktree-owned, not a watcher table:
		// agent-handler tracks unread per SUBSCRIBER, and must not inherit
		// this per-RESOURCE model. Compared against watcher_events.ts, which
		// is the column both timeline queries order by.
		`CREATE TABLE IF NOT EXISTS resource_read_cursor (
			resource_type TEXT NOT NULL,
			resource_id   TEXT NOT NULL,
			last_read_ts  TEXT NOT NULL,
			updated_at    TEXT NOT NULL,
			PRIMARY KEY (resource_type, resource_id)
		)`,
		// Web UI login sessions. token_hash is the SHA-256 of the cookie
		// value, never the value itself, so reading this table never yields
		// a usable login. Timestamps use a fixed-width UTC layout, so string
		// comparison in SQL orders them correctly.
		`CREATE TABLE IF NOT EXISTS ui_sessions (
			token_hash   TEXT PRIMARY KEY,
			label        TEXT NOT NULL,
			created_at   TEXT NOT NULL,
			last_seen_at TEXT NOT NULL,
			expires_at   TEXT NOT NULL
		)`,
		// Free-text notes per worktree, written from the web UI's detail
		// card. Deliberately NOT removed by registry.Unregister: a worktree
		// recreated at the same path gets its notes back. sync_cmux is the
		// per-worktree "mirror to the cmux workspace description" setting.
		`CREATE TABLE IF NOT EXISTS worktree_notes (
			path       TEXT PRIMARY KEY,
			notes      TEXT NOT NULL,
			sync_cmux  INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		)`,
	}
	for _, s := range stmts {
		if _, err := conn.Exec(s); err != nil {
			return err
		}
	}

	// worktree_primary predates user-defined ordering, so databases created
	// before it have the table without sort_order. Add it where it is
	// missing. NULL is the deliberate default: it means "never ordered by
	// hand", which reads sort after explicitly ranked rows, so an upgraded
	// database looks exactly as it did until the user drags something.
	if err := addColumnIfMissing(conn, "worktree_primary", "sort_order", "INTEGER"); err != nil {
		return err
	}

	// Backfill: every already-subscribed non-Slack resource starts fully
	// read, so the feature goes live silent instead of announcing a backlog
	// nobody will clear by hand.
	//
	// Runs on every migrate and is INSERT OR IGNORE, so after the first run
	// it inserts nothing — resources.Add seeds anything newer. It doubles as
	// a safety net for a row that went missing, at the cost of reading that
	// one resource's backlog as seen.
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := conn.Exec(`
		INSERT OR IGNORE INTO resource_read_cursor
			(resource_type, resource_id, last_read_ts, updated_at)
		SELECT s.resource_type, s.resource_id,
		       COALESCE((SELECT MAX(e.ts)
		                   FROM watcher_events e
		                   JOIN watcher_event_resources er ON er.event_id = e.id
		                  WHERE er.resource_type = s.resource_type
		                    AND er.resource_id   = s.resource_id), ?),
		       ?
		  FROM watcher_subscriptions s
		 WHERE s.resource_type <> 'slack'
		   AND s.deleted_at IS NULL
		 GROUP BY s.resource_type, s.resource_id`, now, now); err != nil {
		return err
	}
	return nil
}

// addColumnIfMissing adds col to tbl unless it is already there. SQLite has no
// ADD COLUMN IF NOT EXISTS, and re-running a plain ALTER errors, so the
// presence check is what keeps migrate idempotent.
func addColumnIfMissing(conn *sql.DB, tbl, col, decl string) error {
	var n int
	if err := conn.QueryRow(
		`SELECT COUNT(1) FROM pragma_table_info(?) WHERE name = ?`, tbl, col).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	// tbl/col/decl are package-internal literals, never user input.
	_, err := conn.Exec(`ALTER TABLE ` + tbl + ` ADD COLUMN ` + col + ` ` + decl)
	return err
}
