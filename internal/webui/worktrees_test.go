package webui

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

func seededDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func TestWorktreesEndpoint(t *testing.T) {
	conn := seededDB(t)
	wtPath := t.TempDir() // exists on disk
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})                // primary
	resources.Add(conn, wtPath, resources.Resource{Type: "jira", ID: "J-1", URL: "u2", Related: true}) // related

	// Seed a watcher event tied to the pr resource. This exercises the real
	// subscriber-canonicalization path (wtPath is a t.TempDir(), which on
	// macOS lives under a symlink), proving latest_event_ts is computed via
	// the same canonical subscriber key that resources.Add used, not a raw
	// "worktree:"+path concatenation.
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := conn.Exec(`INSERT INTO watcher_events (id, ts, source, type, title) VALUES (?,?,?,?,?)`,
		"e1", now, "github", "pr_comment", "c"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id, resource_url) VALUES (?,?,?,?)`,
		"e1", "pr", "o/r#1", "u1"); err != nil {
		t.Fatal(err)
	}

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/worktrees")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []worktreeSummary
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 worktree, got %d", len(got))
	}
	w := got[0]
	if w.Branch != "b1" || !w.OnDisk || w.ResourceCount != 2 || w.PrimaryCount != 1 {
		t.Fatalf("summary wrong: %+v", w)
	}
	if w.PrimaryByType["pr"] != 1 {
		t.Fatalf("primary_by_type[pr] = %d, want 1: %+v", w.PrimaryByType["pr"], w)
	}
	if got := w.PrimaryByType["jira"]; got != 0 {
		t.Fatalf("primary_by_type[jira] = %d, want 0 (jira is related): %+v", got, w)
	}
	if w.RelatedCount != 1 {
		t.Fatalf("related_count = %d, want 1: %+v", w.RelatedCount, w)
	}
	if w.LatestEventTS != now {
		t.Fatalf("latest_event_ts = %q, want %q", w.LatestEventTS, now)
	}
}
