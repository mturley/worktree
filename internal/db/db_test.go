package db

import (
	"path/filepath"
	"testing"
)

func TestOpenAtCreatesTables(t *testing.T) {
	p := filepath.Join(t.TempDir(), "worktree.db")
	conn, err := OpenAt(p)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer conn.Close()

	for _, tbl := range []string{"watcher_subscriptions", "worktree_primary", "port_allocations", "worktrees"} {
		var name string
		err := conn.QueryRow(
			`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, tbl).Scan(&name)
		if err != nil {
			t.Fatalf("expected table %q to exist: %v", tbl, err)
		}
	}
}

func TestOpenAtIdempotent(t *testing.T) {
	p := filepath.Join(t.TempDir(), "worktree.db")
	c1, err := OpenAt(p)
	if err != nil {
		t.Fatal(err)
	}
	c1.Close()
	c2, err := OpenAt(p) // second open must not error on existing tables
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}
	c2.Close()
}

func TestPathResolution(t *testing.T) {
	t.Run("WORKTREE_DB override wins", func(t *testing.T) {
		override := "/custom/path/worktree.db"
		t.Setenv("WORKTREE_DB", override)
		t.Setenv("XDG_DATA_HOME", "/should/be/ignored")

		got, err := Path()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != override {
			t.Fatalf("got %q, want %q", got, override)
		}
	})

	t.Run("XDG_DATA_HOME used when WORKTREE_DB unset", func(t *testing.T) {
		t.Setenv("WORKTREE_DB", "")
		xdg := "/xdg/data/home"
		t.Setenv("XDG_DATA_HOME", xdg)

		got, err := Path()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := filepath.Join(xdg, "worktree", "worktree.db")
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})

	t.Run("falls back to HOME/.local/share when both unset", func(t *testing.T) {
		t.Setenv("WORKTREE_DB", "")
		t.Setenv("XDG_DATA_HOME", "")
		home := t.TempDir()
		t.Setenv("HOME", home)

		got, err := Path()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := filepath.Join(home, ".local", "share", "worktree", "worktree.db")
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})
}
