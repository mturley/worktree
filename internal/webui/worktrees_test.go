package webui

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
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
	wtPath := testgit.Worktree(t)
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
	if _, ok := w.PrimaryByType["jira"]; ok {
		t.Fatalf("jira should be absent from primary_by_type (0-count types are omitted), not present with 0: %+v", w)
	}
	if w.RelatedCount != 1 {
		t.Fatalf("related_count = %d, want 1: %+v", w.RelatedCount, w)
	}
	if w.LatestEventTS != now {
		t.Fatalf("latest_event_ts = %q, want %q", w.LatestEventTS, now)
	}
}

func TestWorktreesEndpointFocusResources(t *testing.T) {
	conn := seededDB(t)
	wtPath := testgit.Worktree(t)
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})
	resources.Add(conn, wtPath, resources.Resource{Type: "jira", ID: "J-1", URL: "u2", Related: true})

	prState := `{"title":"Fix the widget","state":"OPEN","author":"octocat"}`
	if err := watcherdb.UpsertResourceState(conn, "pr", "o/r#1", prState, "2026-08-01T00:00:00Z", "2026-08-01T00:05:00Z"); err != nil {
		t.Fatal(err)
	}

	// A second worktree with no resources at all, to prove focus_resources
	// marshals as [] rather than null.
	emptyPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: emptyPath, Repo: "odh", RepoRoot: "/r", Branch: "b2", CreatedAt: "2026-08-13T00:00:00Z"})

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/worktrees")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var got []worktreeSummary
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}

	byBranch := map[string]worktreeSummary{}
	for _, w := range got {
		byBranch[w.Branch] = w
	}

	b1 := byBranch["b1"]
	if len(b1.FocusResources) != 1 {
		t.Fatalf("want 1 focus resource (primary only), got %d: %+v", len(b1.FocusResources), b1.FocusResources)
	}
	fr := b1.FocusResources[0]
	if fr.Type != "pr" || fr.ID != "o/r#1" {
		t.Fatalf("wrong focus resource: %+v", fr)
	}
	if !fr.Primary {
		t.Fatalf("focus resource must be primary: %+v", fr)
	}
	if fr.Title != "Fix the widget" || fr.State != "OPEN" {
		t.Fatalf("focus resource not enriched: %+v", fr)
	}

	// Existing count fields must be unchanged by this addition.
	if b1.PrimaryCount != 1 || b1.RelatedCount != 1 || b1.ResourceCount != 2 {
		t.Fatalf("counts changed unexpectedly: %+v", b1)
	}

	// Empty worktree serializes as [], not null.
	if !strings.Contains(string(body), `"focus_resources":[]`) {
		t.Fatalf("expected an empty focus_resources array in payload, got: %s", string(body))
	}
	if byBranch["b2"].FocusResources == nil {
		t.Fatal("focus_resources must be an empty slice, not nil")
	}
}
