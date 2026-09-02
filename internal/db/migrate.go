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
	}
	for _, s := range stmts {
		if _, err := conn.Exec(s); err != nil {
			return err
		}
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
