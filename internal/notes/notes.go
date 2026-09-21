// Package notes stores the free-text notes a user keeps about a worktree,
// plus whether those notes are mirrored to the worktree's cmux workspace
// description. Keyed by the same path the registry uses.
package notes

import (
	"database/sql"
	"errors"
	"time"
)

// Notes is one worktree's notes. The zero value is what a worktree that has
// never had notes reads as.
type Notes struct {
	Text      string
	SyncCmux  bool
	UpdatedAt string // RFC3339 UTC; empty when never saved
}

// Get returns path's notes, or the zero Notes when none were ever saved.
func Get(conn *sql.DB, path string) (Notes, error) {
	var n Notes
	var sync int
	err := conn.QueryRow(
		`SELECT notes, sync_cmux, updated_at FROM worktree_notes WHERE path = ?`, path,
	).Scan(&n.Text, &sync, &n.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Notes{}, nil
	}
	if err != nil {
		return Notes{}, err
	}
	n.SyncCmux = sync != 0
	return n, nil
}

// Set replaces path's notes and sync setting, stamping updated_at now, and
// returns what was stored.
func Set(conn *sql.DB, path, text string, syncCmux bool) (Notes, error) {
	n := Notes{Text: text, SyncCmux: syncCmux, UpdatedAt: time.Now().UTC().Format(time.RFC3339)}
	sync := 0
	if syncCmux {
		sync = 1
	}
	_, err := conn.Exec(
		`INSERT INTO worktree_notes (path, notes, sync_cmux, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT (path) DO UPDATE SET
		   notes = excluded.notes, sync_cmux = excluded.sync_cmux,
		   updated_at = excluded.updated_at`,
		path, n.Text, sync, n.UpdatedAt)
	if err != nil {
		return Notes{}, err
	}
	return n, nil
}
