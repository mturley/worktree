package webui

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/linkmeta"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
)

func TestAddResourceFollowsAPlainURL(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<html><head><title>A page</title></head></html>`)
	}))
	defer ts.Close()

	conn, _ := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	defer conn.Close()
	wtPath := testgit.Worktree(t)
	srv := &Server{DB: conn, LinkResolver: &linkmeta.Resolver{Transport: ts.Client().Transport}}

	body, _ := json.Marshal(map[string]any{"path": wtPath, "url": ts.URL + "/x#frag"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/worktree-resources/add", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var dto resourceDTO
	json.Unmarshal(rec.Body.Bytes(), &dto)
	if dto.Type != "link" {
		t.Fatalf("type = %q", dto.Type)
	}
	if strings.Contains(dto.ID, "#") {
		t.Fatalf("id must be normalized, got %q", dto.ID)
	}
	// Resolution happens inline, so the card is populated on arrival.
	if dto.Title != "A page" {
		t.Fatalf("title = %q", dto.Title)
	}
}

func TestAddResourceDoesNotPollALink(t *testing.T) {
	// A link has no poller. If one is ever added to pollAll, or pollOne is
	// called for a link, this fails.
	conn, _ := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	defer conn.Close()
	wtPath := testgit.Worktree(t)
	srv := &Server{DB: conn, LinkResolver: &linkmeta.Resolver{}}
	resources.Add(conn, wtPath, resources.Resource{Type: "link", ID: "https://ex.com/a", URL: "https://ex.com/a"})

	if err := srv.pollAll(); err != nil {
		t.Fatal(err)
	}
	evs, _ := watcherdb.EventsForResource(conn, "link", "https://ex.com/a")
	if len(evs) != 0 {
		t.Fatalf("a link must produce no events, got %d", len(evs))
	}
}

func TestResourceTypeEndpointClassifies(t *testing.T) {
	srv := &Server{}
	for _, tc := range []struct{ url, want string }{
		{"https://github.com/o/r/pull/42", "pr"},
		{"https://x.atlassian.net/browse/AB-1", "jira"},
		{"https://example.com/docs", "link"},
		{"./nope", ""},
	} {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/resource-type?url="+url.QueryEscape(tc.url), nil))
		var got struct {
			Type string `json:"type"`
		}
		json.Unmarshal(rec.Body.Bytes(), &got)
		if got.Type != tc.want {
			t.Fatalf("%s -> %q, want %q", tc.url, got.Type, tc.want)
		}
	}
}

func TestResourceResolveRefusesNonLinkTypes(t *testing.T) {
	conn, _ := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	defer conn.Close()
	srv := &Server{DB: conn}
	body, _ := json.Marshal(map[string]string{"type": "pr", "id": "o/r#1"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/resource-resolve", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rec.Code)
	}
}
