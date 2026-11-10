package notes

import (
	"database/sql"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
)

func TestAllNonBlankIgnoresShowOnHome(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := Set(conn, "/a", "shown", false, true); err != nil {
		t.Fatal(err)
	}
	if _, err := Set(conn, "/b", "hidden from home", false, false); err != nil {
		t.Fatal(err)
	}
	if _, err := Set(conn, "/c", "   ", false, true); err != nil {
		t.Fatal(err)
	}
	got, err := AllNonBlank(conn)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got["/a"] != "shown" || got["/b"] != "hidden from home" {
		t.Fatalf("got %v", got)
	}
}

func TestGetWithoutNotesIsDefault(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	n, err := Get(conn, "/wt/none")
	if err != nil {
		t.Fatal(err)
	}
	if n != Default() || !n.ShowOnHome {
		t.Fatalf("Get = %+v, want Default() (shown on home)", n)
	}
}

func TestSetThenGetRoundTrips(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	if _, err := Set(conn, "/wt/a", "first", false, true); err != nil {
		t.Fatal(err)
	}
	stored, err := Set(conn, "/wt/a", "second\nline", true, false)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Get(conn, "/wt/a")
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "second\nline" || !got.SyncCmux || got.ShowOnHome || got.UpdatedAt == "" || got != stored {
		t.Fatalf("Get = %+v, stored %+v", got, stored)
	}
}

func TestNotesSurviveUnregister(t *testing.T) {
	// A worktree recreated at the same path gets its notes back.
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	registry.Register(conn, registry.Entry{Path: "/wt/a", Repo: "r", RepoRoot: "/r", Branch: "b", CreatedAt: "2026-09-21T00:00:00Z"})
	Set(conn, "/wt/a", "keep me", false, true)
	if err := registry.Unregister(conn, "/wt/a"); err != nil {
		t.Fatal(err)
	}
	got, _ := Get(conn, "/wt/a")
	if got.Text != "keep me" {
		t.Fatalf("notes after unregister = %q", got.Text)
	}
}

func TestHomeNotesOnlyShownAndNonEmpty(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	Set(conn, "/wt/shown", "**hi**", false, true)
	Set(conn, "/wt/hidden", "secret", false, false)
	Set(conn, "/wt/blank", "  \n ", false, true)
	got, err := HomeNotes(conn)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got["/wt/shown"] != "**hi**" {
		t.Fatalf("HomeNotes = %v, want only /wt/shown", got)
	}
}

func ptr(s string) *string { return &s }

func newConn(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func TestCompareAndSetInsertsAtVersionZero(t *testing.T) {
	conn := newConn(t)
	n, ok, err := CompareAndSet(conn, "/a", 0, "hello", true, true, ptr("b"), "WS")
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if n.Version != 1 {
		t.Fatalf("version %d", n.Version)
	}
	got, err := Get(conn, "/a")
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "hello" || got.Version != 1 || got.CmuxBase == nil || *got.CmuxBase != "b" || got.CmuxBaseWorkspace != "WS" {
		t.Fatalf("got %+v", got)
	}
}

func TestCompareAndSetRejectsStaleVersion(t *testing.T) {
	conn := newConn(t)
	if _, ok, err := CompareAndSet(conn, "/a", 0, "first", false, true, nil, ""); err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	_, ok, err := CompareAndSet(conn, "/a", 0, "stale", false, true, nil, "")
	if err != nil || ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	got, _ := Get(conn, "/a")
	if got.Text != "first" {
		t.Fatalf("text %q", got.Text)
	}
}

func TestSetBaseDoesNotBumpVersion(t *testing.T) {
	conn := newConn(t)
	if _, ok, err := CompareAndSet(conn, "/a", 0, "t", false, true, nil, ""); err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if ok, err := SetBase(conn, "/a", 1, ptr("b"), "WS"); err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	got, _ := Get(conn, "/a")
	if got.Version != 1 || got.CmuxBase == nil || *got.CmuxBase != "b" || got.CmuxBaseWorkspace != "WS" {
		t.Fatalf("got %+v", got)
	}
	if ok, err := SetBase(conn, "/a", 0, ptr("x"), "Y"); err != nil || ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
}

func TestSetBumpsVersionAndKeepsBase(t *testing.T) {
	conn := newConn(t)
	if _, ok, err := CompareAndSet(conn, "/a", 0, "t", true, true, ptr("b"), "WS"); err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if _, err := Set(conn, "/a", "new", true, true); err != nil {
		t.Fatal(err)
	}
	got, _ := Get(conn, "/a")
	if got.Version != 2 || got.Text != "new" || got.CmuxBase == nil || *got.CmuxBase != "b" {
		t.Fatalf("got %+v", got)
	}
}

func TestFingerprintChangesOnEveryWrite(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fp := func() string {
		t.Helper()
		f, err := Fingerprint(conn)
		if err != nil {
			t.Fatal(err)
		}
		return f
	}
	empty := fp()
	n, err := Set(conn, "/a", "one", false, true)
	if err != nil {
		t.Fatal(err)
	}
	afterSet := fp()
	if afterSet == empty {
		t.Fatal("Set must change the fingerprint")
	}
	if _, ok, err := CompareAndSet(conn, "/a", n.Version, "two", false, true, nil, ""); err != nil || !ok {
		t.Fatalf("CompareAndSet ok=%v err=%v", ok, err)
	}
	afterCAS := fp()
	if afterCAS == afterSet {
		t.Fatal("CompareAndSet must change the fingerprint")
	}
	cur, err := Get(conn, "/a")
	if err != nil {
		t.Fatal(err)
	}
	base := "x"
	if ok, err := SetBase(conn, "/a", cur.Version, &base, "ws"); err != nil || !ok {
		t.Fatalf("SetBase ok=%v err=%v", ok, err)
	}
	if fp() != afterCAS {
		t.Fatal("SetBase must not change the fingerprint")
	}
}
