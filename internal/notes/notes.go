// Package notes stores the free-text notes a user keeps about a worktree,
// plus whether those notes are mirrored to the worktree's cmux workspace
// description and shown on the home page. Keyed by the same path the
// registry uses.
package notes

import (
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Notes is one worktree's notes.
type Notes struct {
	Text       string
	SyncCmux   bool
	ShowOnHome bool
	UpdatedAt  string // RFC3339 UTC; empty when never saved

	// Version counts writes; compare-and-set callers pass the version they read.
	Version int64
	// CmuxBase is the last description text the notes and the cmux workspace
	// agreed on; nil when there is none.
	CmuxBase *string
	// CmuxBaseWorkspace is the workspace CmuxBase was read from.
	CmuxBaseWorkspace string
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
	var base sql.NullString
	err := conn.QueryRow(
		`SELECT notes, sync_cmux, show_on_home, updated_at, version, cmux_base, cmux_base_workspace
		 FROM worktree_notes WHERE path = ?`, path,
	).Scan(&n.Text, &sync, &home, &n.UpdatedAt, &n.Version, &base, &n.CmuxBaseWorkspace)
	if errors.Is(err, sql.ErrNoRows) {
		return Default(), nil
	}
	if err != nil {
		return Notes{}, err
	}
	n.SyncCmux = sync != 0
	n.ShowOnHome = home != 0
	if base.Valid {
		v := base.String
		n.CmuxBase = &v
	}
	return n, nil
}

func nullable(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// CompareAndSet writes text, settings and the cmux base, setting version to
// expect+1 and stamping updated_at, but only when the stored version equals
// expect (expect 0 also matches a missing row). It returns ok=false, without
// error, when the stored version differs.
func CompareAndSet(conn *sql.DB, path string, expect int64, text string, syncCmux, showOnHome bool, base *string, baseWorkspace string) (Notes, bool, error) {
	n := Notes{
		Text: text, SyncCmux: syncCmux, ShowOnHome: showOnHome,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
		Version:   expect + 1, CmuxBase: base, CmuxBaseWorkspace: baseWorkspace,
	}
	if expect == 0 {
		res, err := conn.Exec(
			`INSERT INTO worktree_notes (path, notes, sync_cmux, show_on_home, updated_at, version, cmux_base, cmux_base_workspace)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (path) DO NOTHING`,
			path, n.Text, bit(syncCmux), bit(showOnHome), n.UpdatedAt, n.Version, nullable(base), baseWorkspace)
		if err != nil {
			return Notes{}, false, err
		}
		if c, err := res.RowsAffected(); err != nil {
			return Notes{}, false, err
		} else if c > 0 {
			return n, true, nil
		}
	}
	res, err := conn.Exec(
		`UPDATE worktree_notes SET notes = ?, sync_cmux = ?, show_on_home = ?, updated_at = ?,
		   version = ?, cmux_base = ?, cmux_base_workspace = ?
		 WHERE path = ? AND version = ?`,
		n.Text, bit(syncCmux), bit(showOnHome), n.UpdatedAt, n.Version, nullable(base), baseWorkspace, path, expect)
	if err != nil {
		return Notes{}, false, err
	}
	c, err := res.RowsAffected()
	if err != nil {
		return Notes{}, false, err
	}
	if c == 0 {
		return Notes{}, false, nil
	}
	return n, true, nil
}

// SetBase writes only the cmux base columns, when the stored version equals
// expect. It does not bump version or updated_at. It returns false on a
// version mismatch (or a missing row).
func SetBase(conn *sql.DB, path string, expect int64, base *string, baseWorkspace string) (bool, error) {
	res, err := conn.Exec(
		`UPDATE worktree_notes SET cmux_base = ?, cmux_base_workspace = ? WHERE path = ? AND version = ?`,
		nullable(base), baseWorkspace, path, expect)
	if err != nil {
		return false, err
	}
	c, err := res.RowsAffected()
	return c > 0, err
}

// Set replaces path's notes and settings, stamping updated_at now and bumping
// version, and returns what was stored. The cmux base is left untouched.
func Set(conn *sql.DB, path, text string, syncCmux, showOnHome bool) (Notes, error) {
	updated := time.Now().UTC().Format(time.RFC3339)
	_, err := conn.Exec(
		`INSERT INTO worktree_notes (path, notes, sync_cmux, show_on_home, updated_at, version)
		 VALUES (?, ?, ?, ?, ?, 1)
		 ON CONFLICT (path) DO UPDATE SET
		   notes = excluded.notes, sync_cmux = excluded.sync_cmux,
		   show_on_home = excluded.show_on_home, updated_at = excluded.updated_at,
		   version = worktree_notes.version + 1`,
		path, text, bit(syncCmux), bit(showOnHome), updated)
	if err != nil {
		return Notes{}, err
	}
	return Get(conn, path)
}

// Fingerprint summarises every worktree's notes writes: it changes whenever
// a notes row is added, removed, or written through Set or CompareAndSet
// (each bumps version), and not for SetBase, which only moves the cmux base.
// The live stream compares it to tell open tabs to refetch.
func Fingerprint(conn *sql.DB) (string, error) {
	var count, sum int64
	if err := conn.QueryRow(`SELECT COUNT(*), COALESCE(SUM(version), 0) FROM worktree_notes`).Scan(&count, &sum); err != nil {
		return "", err
	}
	return strconv.FormatInt(count, 10) + ":" + strconv.FormatInt(sum, 10), nil
}

// AllNonBlank returns every worktree's non-blank notes, regardless of its
// "Show notes on home page" setting. Used by search, which must find a
// worktree by its notes even when the card doesn't display them.
func AllNonBlank(conn *sql.DB) (map[string]string, error) {
	rows, err := conn.Query(`SELECT path, notes FROM worktree_notes`)
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
