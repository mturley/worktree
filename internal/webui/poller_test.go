package webui

import (
	"path/filepath"
	"testing"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

func TestIsWorktreeStale(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wtPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})

	s := &Server{DB: conn}
	// No events at all -> stale (should poll).
	if !s.isWorktreeStale(wtPath, time.Minute) {
		t.Fatal("worktree with no events should be stale")
	}
	// Fresh event -> not stale.
	now := time.Now().UTC()
	insertEvent(t, conn, "e1", now.Format(time.RFC3339), "github", "pr_comment", "c", "pr", "o/r#1", "u1")
	if s.isWorktreeStale(wtPath, time.Minute) {
		t.Fatal("worktree with a fresh event should not be stale")
	}
	// Old event -> stale.
	conn.Exec(`UPDATE watcher_events SET ts = ? WHERE id = 'e1'`, now.Add(-5*time.Minute).Format(time.RFC3339))
	if !s.isWorktreeStale(wtPath, time.Minute) {
		t.Fatal("worktree whose newest event is 5m old should be stale (threshold 1m)")
	}
}
