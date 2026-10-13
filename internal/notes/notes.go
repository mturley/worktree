// Package notes stores the free-text notes a user keeps about a worktree,
// plus whether those notes are mirrored to the worktree's cmux workspace
// description and shown on the home page. Keyed by the same path the
// registry uses.
package notes

import (
	"database/sql"
	"errors"
	"strings"
	"time"
)

// Notes is one worktree's notes.
type Notes struct {
	Text       string
	SyncCmux   bool
	ShowOnHome bool
	UpdatedAt  string // RFC3339 UTC; empty when never saved
}

// Default is what a worktree that has never had notes reads as: no text, no
// cmux sync, and shown on the home page once there is something to show.
func Default() Notes { return Notes{ShowOnHome: true} }

func bit(b bool) int {
	if b {
		return 1
	}
	return 0
}

// Get returns path's notes, or Default() when none were ever saved.
func Get(conn *sql.DB, path string) (Notes, error) {
	var n Notes
	var sync, home int
	err := conn.QueryRow(
		`SELECT notes, sync_cmux, show_on_home, updated_at FROM worktree_notes WHERE path = ?`, path,
	).Scan(&n.Text, &sync, &home, &n.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Default(), nil
	}
	if err != nil {
		return Notes{}, err
	}
	n.SyncCmux = sync != 0
	n.ShowOnHome = home != 0
	return n, nil
}

// Set replaces path's notes and settings, stamping updated_at now, and
// returns what was stored.
func Set(conn *sql.DB, path, text string, syncCmux, showOnHome bool) (Notes, error) {
	n := Notes{Text: text, SyncCmux: syncCmux, ShowOnHome: showOnHome, UpdatedAt: time.Now().UTC().Format(time.RFC3339)}
	_, err := conn.Exec(
		`INSERT INTO worktree_notes (path, notes, sync_cmux, show_on_home, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (path) DO UPDATE SET
		   notes = excluded.notes, sync_cmux = excluded.sync_cmux,
		   show_on_home = excluded.show_on_home, updated_at = excluded.updated_at`,
		path, n.Text, bit(syncCmux), bit(showOnHome), n.UpdatedAt)
	if err != nil {
		return Notes{}, err
	}
	return n, nil
}

// HomeNotes returns, by path, the notes of every worktree that shows them on
// the home page and has any (whitespace-only notes count as none). One query
// for the whole worktree list.
func HomeNotes(conn *sql.DB) (map[string]string, error) {
	rows, err := conn.Query(`SELECT path, notes FROM worktree_notes WHERE show_on_home <> 0`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]string)
	for rows.Next() {
		var path, text string
		if err := rows.Scan(&path, &text); err != nil {
			return nil, err
		}
		if strings.TrimSpace(text) != "" {
			out[path] = text
		}
	}
	return out, rows.Err()
}
