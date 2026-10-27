package reviewcomments

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
)

// Side is which side of the diff a comment was written on.
type Side string

const (
	SideOld Side = "old"
	SideNew Side = "new"
)

// SourceDraft marks a comment that has not been sent anywhere.
const SourceDraft = "draft"

// RevUncommitted is the Rev of a comment written against the working tree
// rather than a commit.
const RevUncommitted = "uncommitted"

var (
	ErrNotFound = errors.New("review comment not found")
	ErrConflict = errors.New("review comment changed elsewhere")
)

// Comment is a stored review comment. Timestamps are RFC3339 UTC. RangeFrom
// and RangeTo are empty for "All changes".
type Comment struct {
	ID                                int64
	File                              string
	Side                              Side
	Rev                               string
	Base, BaseRef, RangeFrom, RangeTo string
	Anchor                            Anchor
	Body, Source                      string
	Version                           int
	CreatedAt, UpdatedAt              string
	// GitHubCommentID is the id GitHub returned when the comment was added
	// to a pending review, 0 when it was not; GitHubSentVersion is its
	// Version then. Internal: never sent to the client.
	GitHubCommentID   int64
	GitHubSentVersion int
}

// NewComment is what a caller supplies to Create.
type NewComment struct {
	File                                   string
	Side                                   Side
	Rev, Base, BaseRef, RangeFrom, RangeTo string
	Anchor                                 Anchor
	Body                                   string
}

const selectCols = `id, file, side, start_line, end_line, rev, base, base_ref,
	range_from, range_to, snippet, context_before, context_after,
	body, source, version, created_at, updated_at,
	COALESCE(github_comment_id, 0), COALESCE(github_sent_version, 0)`

type scanner interface{ Scan(dest ...any) error }

func scan(r scanner) (Comment, error) {
	var c Comment
	var side, snippet, before, after string
	if err := r.Scan(&c.ID, &c.File, &side, &c.Anchor.Start, &c.Anchor.End, &c.Rev,
		&c.Base, &c.BaseRef, &c.RangeFrom, &c.RangeTo, &snippet, &before, &after,
		&c.Body, &c.Source, &c.Version, &c.CreatedAt, &c.UpdatedAt,
		&c.GitHubCommentID, &c.GitHubSentVersion); err != nil {
		return Comment{}, err
	}
	c.Side = Side(side)
	for _, f := range []struct {
		raw string
		dst *[]string
	}{{snippet, &c.Anchor.Snippet}, {before, &c.Anchor.Before}, {after, &c.Anchor.After}} {
		if err := json.Unmarshal([]byte(f.raw), f.dst); err != nil {
			return Comment{}, fmt.Errorf("review comment %d: bad anchor json: %w", c.ID, err)
		}
	}
	return c, nil
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

// List returns the worktree's comments ordered by file, then start line.
func List(conn *sql.DB, path string) ([]Comment, error) {
	rows, err := conn.Query(`SELECT `+selectCols+` FROM review_comments
		WHERE worktree = ? ORDER BY file, start_line, id`, wdb.Subscriber(path))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Comment
	for rows.Next() {
		c, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func get(conn *sql.DB, sub string, id int64) (Comment, error) {
	c, err := scan(conn.QueryRow(`SELECT `+selectCols+` FROM review_comments
		WHERE id = ? AND worktree = ?`, id, sub))
	if errors.Is(err, sql.ErrNoRows) {
		return Comment{}, ErrNotFound
	}
	return c, err
}

// Create stores a new draft comment at version 1. The anchor must be
// internally consistent because Resolve trusts it once loaded.
func Create(conn *sql.DB, path string, n NewComment) (Comment, error) {
	a := n.Anchor
	if a.Start < 1 || a.End < a.Start || a.End != a.Start+len(a.Snippet)-1 {
		return Comment{}, fmt.Errorf("inconsistent anchor: lines %d-%d with %d snippet lines", a.Start, a.End, len(a.Snippet))
	}
	enc := make([]string, 3)
	for i, lines := range [][]string{a.Snippet, a.Before, a.After} {
		if lines == nil {
			lines = []string{}
		}
		b, err := json.Marshal(lines)
		if err != nil {
			return Comment{}, err
		}
		enc[i] = string(b)
	}
	sub := wdb.Subscriber(path)
	ts := now()
	res, err := conn.Exec(`INSERT INTO review_comments
		(worktree, file, side, start_line, end_line, rev, base, base_ref, range_from, range_to,
		 snippet, context_before, context_after, body, source, version, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
		sub, n.File, string(n.Side), a.Start, a.End, n.Rev, n.Base, n.BaseRef, n.RangeFrom, n.RangeTo,
		enc[0], enc[1], enc[2], n.Body, SourceDraft, ts, ts)
	if err != nil {
		return Comment{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Comment{}, err
	}
	return get(conn, sub, id)
}

// Update changes a comment's body if version is still current. On a stale
// version it returns the current comment together with ErrConflict.
func Update(conn *sql.DB, path string, id int64, version int, body string) (Comment, error) {
	sub := wdb.Subscriber(path)
	res, err := conn.Exec(`UPDATE review_comments SET body = ?, version = version + 1, updated_at = ?
		WHERE id = ? AND worktree = ? AND version = ?`, body, now(), id, sub, version)
	if err != nil {
		return Comment{}, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return Comment{}, err
	}
	c, err := get(conn, sub, id)
	if err != nil {
		return Comment{}, err
	}
	if n == 0 {
		return c, ErrConflict
	}
	return c, nil
}

// Delete removes a comment; a missing one is not an error.
func Delete(conn *sql.DB, path string, id int64) error {
	_, err := conn.Exec(`DELETE FROM review_comments WHERE id = ? AND worktree = ?`, id, wdb.Subscriber(path))
	return err
}

// DeleteIfVersion removes a comment only while its version is still
// version, reporting whether it did. A comment edited since, or already
// gone, is kept (or stays gone) and is false.
func DeleteIfVersion(conn *sql.DB, path string, id int64, version int) (bool, error) {
	res, err := conn.Exec(`DELETE FROM review_comments WHERE id = ? AND worktree = ? AND version = ?`,
		id, wdb.Subscriber(path), version)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// SetGitHubCommentID records that the comment, at version, was added to a
// pending review on GitHub as ghID. A missing comment is not an error.
func SetGitHubCommentID(conn *sql.DB, path string, id, ghID int64, version int) error {
	_, err := conn.Exec(`UPDATE review_comments SET github_comment_id = ?, github_sent_version = ?
		WHERE id = ? AND worktree = ?`, ghID, version, id, wdb.Subscriber(path))
	return err
}

// ClearGitHubCommentID forgets the comment's GitHub id, so it can be sent
// again. A missing comment is not an error.
func ClearGitHubCommentID(conn *sql.DB, path string, id int64) error {
	_, err := conn.Exec(`UPDATE review_comments SET github_comment_id = NULL, github_sent_version = NULL
		WHERE id = ? AND worktree = ?`, id, wdb.Subscriber(path))
	return err
}

// DeleteAll removes every comment for the worktree.
func DeleteAll(conn *sql.DB, path string) error {
	_, err := conn.Exec(`DELETE FROM review_comments WHERE worktree = ?`, wdb.Subscriber(path))
	return err
}
