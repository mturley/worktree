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
		// per-worktree "mirror to the cmux workspace description" setting;
		// show_on_home is "show these notes on the home page's worktree card".
		`CREATE TABLE IF NOT EXISTS worktree_notes (
			path         TEXT PRIMARY KEY,
			notes        TEXT NOT NULL,
			sync_cmux    INTEGER NOT NULL DEFAULT 0,
			show_on_home INTEGER NOT NULL DEFAULT 1,
			updated_at   TEXT NOT NULL
		)`,
		// Notification toggles (internal/notifyprefs). A row means "on"; a
		// row with an empty resource_type/resource_id is the worktree-wide
		// toggle. Unlike worktree_notes these are removed with the
		// worktree's resources (resources.Remove/RemoveAll): they are
		// settings about subscriptions, and outlive nothing.
		`CREATE TABLE IF NOT EXISTS worktree_notify (
			subscriber    TEXT NOT NULL,
			resource_type TEXT NOT NULL,
			resource_id   TEXT NOT NULL,
			created_at    TEXT NOT NULL,
			PRIMARY KEY (subscriber, resource_type, resource_id)
		)`,
		// The user's own account ID per source (internal/selfid), so queries
		// can leave out events the user caused. Written by worktree ui at
		// startup; read by every unread and notification query.
		`CREATE TABLE IF NOT EXISTS self_identity (
			source     TEXT PRIMARY KEY,
			author_id  TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		// To-do items (internal/tasks). Worktree-owned. rank is a fractional
		// index (tasks.KeyBetween) giving one master order across every task;
		// a move rewrites only the moved row. deleted_at is a soft delete.
		`CREATE TABLE IF NOT EXISTS tasks (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			title        TEXT NOT NULL,
			description  TEXT NOT NULL DEFAULT '',
			state        TEXT NOT NULL DEFAULT 'not_started',
			priority     TEXT NOT NULL DEFAULT 'none',
			starred      INTEGER NOT NULL DEFAULT 0,
			due_date     TEXT,
			rank         TEXT NOT NULL,
			created_at   TEXT NOT NULL,
			updated_at   TEXT NOT NULL,
			started_at   TEXT,
			completed_at TEXT,
			deleted_at   TEXT
		)`,
		// Master order: rank, with id breaking ties.
		`CREATE INDEX IF NOT EXISTS tasks_rank ON tasks (rank, id)`,
		// A task's links to a resource (type + id) or a worktree (canonical
		// path). is_primary marks a Focus link; anything else is Related.
		// Unused columns for the other kind stay '' so UNIQUE still dedups.
		`CREATE TABLE IF NOT EXISTS task_links (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			kind          TEXT NOT NULL CHECK (kind IN ('resource','worktree')),
			resource_type TEXT NOT NULL DEFAULT '',
			resource_id   TEXT NOT NULL DEFAULT '',
			worktree_path TEXT NOT NULL DEFAULT '',
			is_primary    INTEGER NOT NULL DEFAULT 0,
			sort_order    INTEGER,
			created_at    TEXT NOT NULL,
			UNIQUE (task_id, kind, resource_type, resource_id, worktree_path)
		)`,
		// Reverse lookups: which tasks link a given resource or worktree.
		`CREATE INDEX IF NOT EXISTS task_links_resource ON task_links (resource_type, resource_id)`,
		`CREATE INDEX IF NOT EXISTS task_links_worktree ON task_links (worktree_path)`,
		// A task's checklist, ordered by position.
		`CREATE TABLE IF NOT EXISTS task_subtasks (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			text       TEXT NOT NULL,
			checked    INTEGER NOT NULL DEFAULT 0,
			position   INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		// A task's history. Deliberately NOT watcher_events: those belong to
		// the watcher library's schema, shared with agent-handler. No FK to
		// tasks, because history must outlive a later (Phase 6) purge
		// decision. actor is 'user' or 'agent'. ts uses the same RFC3339 UTC
		// second format as the rest of the DB.
		`CREATE TABLE IF NOT EXISTS task_events (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id       INTEGER NOT NULL,
			ts            TEXT NOT NULL,
			type          TEXT NOT NULL,
			actor         TEXT NOT NULL,
			actor_session TEXT NOT NULL DEFAULT '',
			payload       TEXT NOT NULL DEFAULT '{}'
		)`,
		// Specific activity events a task points at. event_key is an identity
		// ('ev:<watcher_events.id>' or 'slack:<channel>:<ts>'); snapshot is the
		// JSON an event row renders from once the live event is gone.
		`CREATE TABLE IF NOT EXISTS task_event_links (
			task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			event_key  TEXT NOT NULL,
			snapshot   TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (task_id, event_key)
		)`,
		// A task's feed, newest first.
		`CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task_id, ts)`,
		// The activity feeds, newest first across tasks (tasks.FeedEvents).
		`CREATE INDEX IF NOT EXISTS task_events_ts ON task_events (ts, id)`,
		// A single-row change counter for tasks. Every committed write in
		// internal/tasks bumps v, moves and subtask reorders included (they
		// record no task_events), so a reader polling it learns "something
		// changed" without diffing.
		`CREATE TABLE IF NOT EXISTS tasks_version (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			v  INTEGER NOT NULL
		)`,
		`INSERT OR IGNORE INTO tasks_version (id, v) VALUES (1, 0)`,
		// What blocks a task (internal/tasks blockers.go): another task
		// (blocking_task_id), a resource (resource_type + resource_id) or
		// free text. resolved_at is NULL while the blocker holds;
		// resolved_auto says the resolver (not the user) resolved it.
		// resource_url is the URL the user pasted for a resource blocker
		// ('' when added by type+id), handed on to the resource's hold.
		`CREATE TABLE IF NOT EXISTS task_blockers (
			id               INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id          INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			kind             TEXT NOT NULL CHECK (kind IN ('task','resource','other')),
			blocking_task_id INTEGER,
			resource_type    TEXT NOT NULL DEFAULT '',
			resource_id      TEXT NOT NULL DEFAULT '',
			resource_url     TEXT NOT NULL DEFAULT '',
			text             TEXT NOT NULL DEFAULT '',
			resolved_at      TEXT,
			resolved_auto    INTEGER NOT NULL DEFAULT 0,
			resolved_reason  TEXT NOT NULL DEFAULT '',
			created_at       TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS task_blockers_task ON task_blockers (task_id)`,
		`CREATE INDEX IF NOT EXISTS task_blockers_blocking ON task_blockers (blocking_task_id)`,
		`CREATE INDEX IF NOT EXISTS task_blockers_resource ON task_blockers (resource_type, resource_id)`,
		// Review comments on a worktree's diff. Unlike worktree_notes, these
		// are removed with the worktree by resources.RemoveAll. Positions are
		// never trusted from clients; the anchor (lines, snippet, context) is
		// written once at create time.
		`CREATE TABLE IF NOT EXISTS review_comments (
			id             INTEGER PRIMARY KEY AUTOINCREMENT,
			worktree       TEXT NOT NULL, -- wdb.Subscriber(path)
			file           TEXT NOT NULL,
			side           TEXT NOT NULL CHECK (side IN ('old','new')),
			start_line     INTEGER NOT NULL,
			end_line       INTEGER NOT NULL,
			rev            TEXT NOT NULL,
			base           TEXT NOT NULL,
			base_ref       TEXT NOT NULL,
			range_from     TEXT NOT NULL DEFAULT '',
			range_to       TEXT NOT NULL DEFAULT '',
			snippet        TEXT NOT NULL,
			context_before TEXT NOT NULL, -- JSON array of lines
			context_after  TEXT NOT NULL, -- JSON array of lines
			body           TEXT NOT NULL,
			source         TEXT NOT NULL DEFAULT 'draft',
			version        INTEGER NOT NULL DEFAULT 1,
			created_at     TEXT NOT NULL,
			updated_at     TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS review_comments_worktree ON review_comments(worktree)`,
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
	// Likewise worktree_notes predates show_on_home. It defaults ON, so
	// existing notes start showing on the home page.
	if err := addColumnIfMissing(conn, "worktree_notes", "show_on_home", "INTEGER NOT NULL DEFAULT 1"); err != nil {
		return err
	}

	// task_blockers predates resource_url (a pre-release Tasks database).
	if err := addColumnIfMissing(conn, "task_blockers", "resource_url", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	// resolved_event_id is the task_blocker_resolved event that resolved
	// the blocker (NULL while unresolved, and for resolutions recorded
	// before it existed). Undo matches a cascade by it exactly.
	if err := addColumnIfMissing(conn, "task_blockers", "resolved_event_id", "INTEGER"); err != nil {
		return err
	}

	// Only state-like task changes are task events: creation, state
	// changes, deletion, blocker resolution and subtask checks. Edits used
	// to be recorded too; their rows go. Like the backfill below this runs
	// on every migrate, and once they are gone it deletes nothing, since
	// nothing writes these types any more.
	if _, err := conn.Exec(`
		DELETE FROM task_events WHERE type IN (
			'task_edited', 'task_linked', 'task_unlinked', 'task_focus_changed',
			'subtask_added', 'subtask_edited', 'subtask_removed',
			'task_event_linked', 'task_event_unlinked',
			'task_blocker_added', 'task_blocker_removed')`); err != nil {
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
