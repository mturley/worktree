package db

import "database/sql"

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
	}
	for _, s := range stmts {
		if _, err := conn.Exec(s); err != nil {
			return err
		}
	}
	return nil
}
