// Package uisession stores the web UI's login sessions in worktree's own
// database. The cookie carries a random token; the table holds only its
// SHA-256, called the session's handle, which is also what the UI uses to
// name a session when revoking it.
package uisession

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"time"
)

const (
	// Lifetime is how long a session lasts from login. It does not slide.
	Lifetime = 30 * 24 * time.Hour
	// TouchInterval is the minimum age of last_seen_at before a request
	// rewrites it. A write per request would put the database on the path
	// of every image load.
	TouchInterval = 5 * time.Minute
)

// tsLayout is fixed-width so that stored timestamps sort as strings.
const tsLayout = "2006-01-02T15:04:05.000000000Z"

type Session struct {
	Handle     string
	Label      string
	CreatedAt  time.Time
	LastSeenAt time.Time
	ExpiresAt  time.Time
}

type Store struct {
	DB *sql.DB
	// Now is the clock; nil means time.Now. A seam for tests.
	Now func() time.Time
}

func (s *Store) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

// HandleFor returns the handle of a token: its hex SHA-256.
func HandleFor(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Create starts a session. The token goes in the cookie and is not kept.
func (s *Store) Create(label string) (string, Session, error) {
	token, err := newToken()
	if err != nil {
		return "", Session{}, err
	}
	now := s.now()
	sess := Session{
		Handle:     HandleFor(token),
		Label:      label,
		CreatedAt:  now,
		LastSeenAt: now,
		ExpiresAt:  now.Add(Lifetime),
	}
	_, err = s.DB.Exec(`INSERT INTO ui_sessions
		(token_hash, label, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		sess.Handle, sess.Label, now.Format(tsLayout), now.Format(tsLayout),
		sess.ExpiresAt.Format(tsLayout))
	if err != nil {
		return "", Session{}, err
	}
	return token, sess, nil
}

// Lookup returns the live session for a token. An empty, unknown, revoked
// or expired token reports false with a nil error.
func (s *Store) Lookup(token string) (Session, bool, error) {
	if token == "" {
		return Session{}, false, nil
	}
	row := s.DB.QueryRow(`SELECT token_hash, label, created_at, last_seen_at, expires_at
		FROM ui_sessions WHERE token_hash = ?`, HandleFor(token))
	sess, err := scanSession(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, false, nil
	}
	if err != nil {
		return Session{}, false, err
	}
	if !s.now().Before(sess.ExpiresAt) {
		return Session{}, false, nil
	}
	return sess, true, nil
}

// Touch records use of sess, but only once last_seen_at is at least
// TouchInterval old. It reports whether it wrote.
func (s *Store) Touch(sess Session) (bool, error) {
	now := s.now()
	if now.Sub(sess.LastSeenAt) < TouchInterval {
		return false, nil
	}
	if _, err := s.DB.Exec(`UPDATE ui_sessions SET last_seen_at = ? WHERE token_hash = ?`,
		now.Format(tsLayout), sess.Handle); err != nil {
		return false, err
	}
	return true, nil
}

// Revoke deletes one session by handle and reports whether it existed.
func (s *Store) Revoke(handle string) (bool, error) {
	res, err := s.DB.Exec(`DELETE FROM ui_sessions WHERE token_hash = ?`, handle)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// RevokeAll deletes every session, logging out every device.
func (s *Store) RevokeAll() (int64, error) {
	res, err := s.DB.Exec(`DELETE FROM ui_sessions`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// List returns the live sessions, newest first.
func (s *Store) List() ([]Session, error) {
	rows, err := s.DB.Query(`SELECT token_hash, label, created_at, last_seen_at, expires_at
		FROM ui_sessions WHERE expires_at > ? ORDER BY created_at DESC`,
		s.now().Format(tsLayout))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		sess, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sess)
	}
	return out, rows.Err()
}

// DeleteExpired removes sessions past their expiry.
func (s *Store) DeleteExpired() (int64, error) {
	res, err := s.DB.Exec(`DELETE FROM ui_sessions WHERE expires_at <= ?`, s.now().Format(tsLayout))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func scanSession(r interface{ Scan(...any) error }) (Session, error) {
	var sess Session
	var created, seen, expires string
	if err := r.Scan(&sess.Handle, &sess.Label, &created, &seen, &expires); err != nil {
		return Session{}, err
	}
	var err error
	if sess.CreatedAt, err = time.Parse(tsLayout, created); err != nil {
		return Session{}, err
	}
	if sess.LastSeenAt, err = time.Parse(tsLayout, seen); err != nil {
		return Session{}, err
	}
	if sess.ExpiresAt, err = time.Parse(tsLayout, expires); err != nil {
		return Session{}, err
	}
	return sess, nil
}
