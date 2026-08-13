package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
)

func TestWorktreeResourcesEndpoint(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wtPath := t.TempDir()
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})                // primary
	resources.Add(conn, wtPath, resources.Resource{Type: "jira", ID: "J-1", URL: "u2", Related: true}) // related

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktree-resources?path=" + url.QueryEscape(wtPath))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []resourceDTO
	json.NewDecoder(resp.Body).Decode(&got)
	if len(got) != 2 {
		t.Fatalf("want 2, got %d", len(got))
	}
	var prPrimary, jiraPrimary bool
	for _, r := range got {
		if r.Type == "pr" {
			prPrimary = r.Primary
		}
		if r.Type == "jira" {
			jiraPrimary = r.Primary
		}
	}
	if !prPrimary || jiraPrimary {
		t.Fatalf("pr should be primary, jira related: %+v", got)
	}
}
