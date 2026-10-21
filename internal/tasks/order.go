package tasks

import (
	"database/sql"
	"errors"
)

// MoveAfter places id immediately after afterID in the master order.
func MoveAfter(conn *sql.DB, id, afterID int64) error {
	return moveRelative(conn, id, afterID, true)
}

// MoveBefore places id immediately before beforeID in the master order.
func MoveBefore(conn *sql.DB, id, beforeID int64) error {
	return moveRelative(conn, id, beforeID, false)
}

// MoveToTop places id before every other task.
func MoveToTop(conn *sql.DB, id int64) error {
	return inTx(conn, func(tx dbtx) error {
		if _, err := load(tx, id); err != nil {
			return err
		}
		var first sql.NullString
		if err := tx.QueryRowContext(bg, `SELECT MIN(rank) FROM tasks WHERE id != ?`, id).Scan(&first); err != nil {
			return err
		}
		return writeRank(tx, id, "", first.String)
	})
}

// MoveToBottom places id after every other task.
func MoveToBottom(conn *sql.DB, id int64) error {
	return inTx(conn, func(tx dbtx) error {
		if _, err := load(tx, id); err != nil {
			return err
		}
		var last sql.NullString
		if err := tx.QueryRowContext(bg, `SELECT MAX(rank) FROM tasks WHERE id != ?`, id).Scan(&last); err != nil {
			return err
		}
		return writeRank(tx, id, last.String, "")
	})
}

// moveRelative moves id next to ref. The neighbour on the far side is found
// among ALL other rows, deleted included, so hidden tasks stay where they
// were. Bounds are strictly greater/smaller ranks, so a tie on ref's rank
// can never yield an empty KeyBetween interval; the move lands just outside
// the whole tied group. Only id's row is rewritten, and no event is recorded.
func moveRelative(conn *sql.DB, id, ref int64, after bool) error {
	return inTx(conn, func(tx dbtx) error {
		if _, err := load(tx, id); err != nil {
			return err
		}
		r, err := load(tx, ref)
		if err != nil {
			return err
		}
		if id == ref {
			return nil
		}
		var lo, hi string
		var other sql.NullString
		if after {
			err = tx.QueryRowContext(bg,
				`SELECT rank FROM tasks WHERE id != ? AND rank > ?
				 ORDER BY rank LIMIT 1`, id, r.Rank).Scan(&other)
			lo, hi = r.Rank, other.String
		} else {
			err = tx.QueryRowContext(bg,
				`SELECT rank FROM tasks WHERE id != ? AND rank < ?
				 ORDER BY rank DESC LIMIT 1`, id, r.Rank).Scan(&other)
			lo, hi = other.String, r.Rank
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		return writeRank(tx, id, lo, hi)
	})
}

// writeRank sets id's rank to a key between lo and hi ("" = unbounded).
func writeRank(tx dbtx, id int64, lo, hi string) error {
	key, err := KeyBetween(lo, hi)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(bg, `UPDATE tasks SET rank = ? WHERE id = ?`, key, id)
	return err
}
