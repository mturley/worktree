package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/selfid"
	"github.com/mturley/worktree/internal/testgit"
)

func TestAllResourcesEndpoint(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	a, b := testgit.Worktree(t), testgit.Worktree(t)
	for _, p := range []string{a, b} {
		if err := registry.Register(conn, registry.Entry{Path: p, Repo: "r", RepoRoot: p, Branch: filepath.Base(p), CreatedAt: "now"}); err != nil {
			t.Fatal(err)
		}
	}
	// The PR is followed by both worktrees — related in a, focus in b.
	must(t, resources.Add(conn, a, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1", Related: true}))
	must(t, resources.Add(conn, b, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}))
	must(t, resources.Add(conn, a, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u2"}))
	must(t, resources.Add(conn, b, resources.Resource{Type: "jira", ID: "J-1", URL: "u3"}))
	must(t, watcherdb.UpsertResourceState(conn, "pr", "o/r#1",
		`{"title":"Mine","state":"OPEN","author_id":"101","created_at":"2026-01-01T00:00:00Z"}`, "2026-02-01T00:00:00Z", "x"))
	must(t, watcherdb.UpsertResourceState(conn, "pr", "o/r#2",
		`{"title":"Theirs","state":"OPEN","author_id":"202"}`, "2026-02-01T00:00:00Z", "x"))
	must(t, watcherdb.UpsertResourceState(conn, "jira", "J-1",
		`{"summary":"S","status":"New","reporter_id":"someone","assignee_id":"acct-me","created_at":"2026-03-01T00:00:00Z"}`, "2026-04-01T00:00:00Z", "x"))
	must(t, selfid.Set(conn, "github", "101"))
	must(t, selfid.Set(conn, "jira", "acct-me"))

	ts := httptest.NewServer((&Server{DB: conn}).Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/all-resources")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("want 3 distinct resources, got %d: %+v", len(got), got)
	}
	by := map[string]map[string]any{}
	for _, r := range got {
		by[r["id"].(string)] = r
		if _, leaked := r["author_id"]; leaked {
			t.Errorf("account IDs must not be sent: %+v", r)
		}
	}
	pr1 := by["o/r#1"]
	if wts := pr1["worktrees"].([]any); len(wts) != 2 {
		t.Errorf("o/r#1 worktrees = %v, want both", wts)
	}
	if pr1["primary"] != true {
		t.Errorf("o/r#1 is focus in one worktree, so primary: %+v", pr1)
	}
	if pr1["mine"] != true || pr1["created_at"] != "2026-01-01T00:00:00Z" {
		t.Errorf("o/r#1 mine/created_at: %+v", pr1)
	}
	if by["o/r#2"]["mine"] != nil {
		t.Errorf("o/r#2 is someone else's: %+v", by["o/r#2"])
	}
	if by["J-1"]["mine"] != true || by["J-1"]["created_at"] != "2026-03-01T00:00:00Z" {
		t.Errorf("J-1 is assigned to me: %+v", by["J-1"])
	}
}

func TestEnrichJiraReporter(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	must(t, err)
	defer conn.Close()
	must(t, watcherdb.UpsertResourceState(conn, "jira", "J-9", `{"summary":"S","reporter":"Karel Suta"}`, "2026-01-01T00:00:00Z", "x"))
	srv := &Server{DB: conn}
	dto := resourceDTO{Type: "jira", ID: "J-9"}
	srv.enrichResourceDTO(&dto)
	if dto.Reporter != "Karel Suta" {
		t.Fatalf("reporter = %q", dto.Reporter)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
