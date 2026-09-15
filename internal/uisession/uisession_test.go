package uisession

import (
	"path/filepath"
	"testing"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
)

// clock is a settable time source for Store.Now.
type clock struct{ t time.Time }

func (c *clock) now() time.Time         { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newStore(t *testing.T) (*Store, *clock) {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	c := &clock{t: time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)}
	return &Store{DB: conn, Now: c.now}, c
}

func TestCreateThenLookup(t *testing.T) {
	s, _ := newStore(t)
	token, sess, err := s.Create("Mac — Chrome")
	if err != nil {
		t.Fatal(err)
	}
	if len(token) < 40 {
		t.Fatalf("token %q is too short to be 32 random bytes", token)
	}
	got, ok, err := s.Lookup(token)
	if err != nil || !ok {
		t.Fatalf("Lookup = %v, %v", ok, err)
	}
	if got.Handle != sess.Handle || got.Label != "Mac — Chrome" {
		t.Fatalf("Lookup returned %+v, want %+v", got, sess)
	}
	if !got.ExpiresAt.Equal(got.CreatedAt.Add(Lifetime)) {
		t.Fatalf("ExpiresAt = %v, want CreatedAt + 30 days", got.ExpiresAt)
	}
}

func TestTokenIsNeverStored(t *testing.T) {
	s, _ := newStore(t)
	token, _, err := s.Create("x")
	if err != nil {
		t.Fatal(err)
	}
	var n int
	err = s.DB.QueryRow(`SELECT COUNT(*) FROM ui_sessions
		WHERE token_hash = ? OR label = ? OR created_at = ? OR last_seen_at = ? OR expires_at = ?`,
		token, token, token, token, token).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("the raw token appears in ui_sessions")
	}
	if HandleFor(token) == token {
		t.Fatal("HandleFor returned the token unchanged")
	}
}

func TestLookupUnknownAndEmptyTokens(t *testing.T) {
	s, _ := newStore(t)
	for _, tok := range []string{"", "not-a-token"} {
		if _, ok, err := s.Lookup(tok); ok || err != nil {
			t.Errorf("Lookup(%q) = %v, %v; want false, nil", tok, ok, err)
		}
	}
}

func TestRevokedSessionIsGone(t *testing.T) {
	s, _ := newStore(t)
	token, sess, _ := s.Create("a")
	other, _, _ := s.Create("b")
	if ok, err := s.Revoke(sess.Handle); !ok || err != nil {
		t.Fatalf("Revoke = %v, %v", ok, err)
	}
	if _, ok, _ := s.Lookup(token); ok {
		t.Fatal("revoked session still looks up")
	}
	if _, ok, _ := s.Lookup(other); !ok {
		t.Fatal("revoking one session removed another")
	}
	if ok, _ := s.Revoke(sess.Handle); ok {
		t.Fatal("revoking twice reported success")
	}
}

func TestExpiredSessionIsRefusedAndDeleted(t *testing.T) {
	s, c := newStore(t)
	token, _, _ := s.Create("a")
	c.advance(Lifetime)
	if _, ok, _ := s.Lookup(token); ok {
		t.Fatal("session still valid at its expiry instant")
	}
	n, err := s.DeleteExpired()
	if err != nil || n != 1 {
		t.Fatalf("DeleteExpired = %d, %v; want 1", n, err)
	}
}

func TestTouchIsThrottled(t *testing.T) {
	s, c := newStore(t)
	token, sess, _ := s.Create("a")

	c.advance(TouchInterval - time.Second)
	if wrote, err := s.Touch(sess); wrote || err != nil {
		t.Fatalf("Touch inside the interval = %v, %v; want no write", wrote, err)
	}
	got, _, _ := s.Lookup(token)
	if !got.LastSeenAt.Equal(sess.LastSeenAt) {
		t.Fatalf("LastSeenAt changed to %v inside the throttle window", got.LastSeenAt)
	}

	c.advance(time.Second)
	if wrote, err := s.Touch(got); !wrote || err != nil {
		t.Fatalf("Touch at the interval = %v, %v; want a write", wrote, err)
	}
	got, _, _ = s.Lookup(token)
	if !got.LastSeenAt.Equal(c.now()) {
		t.Fatalf("LastSeenAt = %v, want %v", got.LastSeenAt, c.now())
	}
}

func TestListIsLiveSessionsNewestFirst(t *testing.T) {
	s, c := newStore(t)
	_, old, _ := s.Create("old")
	c.advance(time.Hour)
	_, mid, _ := s.Create("mid")
	c.advance(time.Hour)
	_, newest, _ := s.Create("new")
	c.advance(Lifetime - 90*time.Minute) // old has expired; mid and new have not
	list, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Handle != newest.Handle || list[1].Handle != mid.Handle {
		t.Fatalf("List = %+v, want [new, mid] without %s", list, old.Handle)
	}
}

func TestRevokeAll(t *testing.T) {
	s, _ := newStore(t)
	s.Create("a")
	s.Create("b")
	n, err := s.RevokeAll()
	if err != nil || n != 2 {
		t.Fatalf("RevokeAll = %d, %v; want 2", n, err)
	}
	if list, _ := s.List(); len(list) != 0 {
		t.Fatalf("List after RevokeAll = %v", list)
	}
}
