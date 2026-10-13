package notes

import (
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
)

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
