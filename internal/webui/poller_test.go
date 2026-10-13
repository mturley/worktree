package webui

import (
	"io"
	"log"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
)

func TestIsWorktreeStale(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wtPath := testgit.Worktree(t)
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
	// Isolate watcher config to an empty dir so pollOne finds no creds and
	// truly no-ops — without this, on a machine that has github/jira/slack
	// creds configured, pollOne would make a live network call (the test
	// would then exercise the poll-error branch, not the no-op it claims).
	t.Setenv("WATCHER_HOME", t.TempDir())

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

func TestPollAll_UnconfiguredSourceWritesWarnRow(t *testing.T) {
	t.Setenv("WATCHER_HOME", t.TempDir()) // no auth.yaml → nothing configured
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := watcherdb.Subscribe(conn, "worktree:/x", watcher.Resource{Type: "pr", ID: "o/r#1"}, watcherdb.SubscribeOpts{}); err != nil {
		t.Fatal(err)
	}
	srv := &Server{DB: conn, Logger: log.New(io.Discard, "", 0)}
	if err := srv.pollAll(); err != nil {
		t.Fatal(err)
	}
	rows, _, err := watcherdb.QueryPollLog(conn, watcherdb.PollLogQuery{MinLevel: "warn"})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Source != "github" || rows[0].Kind != "poll" || !strings.Contains(rows[0].Message, "not configured") {
		t.Fatalf("rows = %+v", rows)
	}
}
