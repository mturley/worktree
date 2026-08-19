package webui

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/mturley/watcher"
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

// TestPollOne_NoCredsIsNoOp asserts pollOne is a safe no-op with no
// configured creds: it must not panic and must not error out the caller
// (the add-resource endpoint calls this inline). We can't assert enrichment
// without live creds; this guards the degenerate path.
func TestPollOne_NoCredsIsNoOp(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	s := &Server{DB: conn}
	s.pollOne(watcher.Resource{Type: "pr", ID: "o/r#1", URL: "https://github.com/o/r/pull/1"})
	// no panic, no assertion beyond reaching here
}

// TestSafePollAllSkipsWhenInFlight verifies the atomic guard: if a poll is
// already marked in-flight, a concurrent safePollAll call must no-op rather
// than run pollAll (which would race on the DB/resource set). We can't
// observe pollAll directly without live creds/network, but pollAll's own
// success path always defers pollInFlight.Store(false); if safePollAll had
// run pollAll to completion it would clear the flag we set. Asserting the
// flag is untouched proves the CompareAndSwap guard skipped the run.
func TestSafePollAllSkipsWhenInFlight(t *testing.T) {
	s := &Server{}
	s.pollInFlight.Store(true)
	s.safePollAll()
	if !s.pollInFlight.Load() {
		t.Fatal("safePollAll should have skipped (pollInFlight was already true) and left the flag untouched")
	}
}
