package webui

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
	"github.com/mturley/worktree/internal/unread"
)

func unreadTestDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func insertUnreadEvent(t *testing.T, conn *sql.DB, id, ts, source, resType, resID string) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO watcher_events (id, ts, source, type, title) VALUES (?, ?, ?, 'pr_comment', 'x')`,
		id, ts, source); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id) VALUES (?, ?, ?)`,
		id, resType, resID); err != nil {
		t.Fatal(err)
	}
}

func TestWorktreeResourcesCarriesUnreadCount(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	// Two events land AFTER the resource was tracked, so both are unread.
	insertUnreadEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	insertUnreadEvent(t, conn, "e2", "2099-01-02T00:00:00Z", "github", "pr", "o/r#1")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktree-resources?path=" + url.QueryEscape(wt))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []resourceDTO
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d resources, want 1", len(got))
	}
	if got[0].UnreadCount != 2 {
		t.Fatalf("unread_count = %d, want 2", got[0].UnreadCount)
	}
}

func registerWorktreeForTest(t *testing.T, conn *sql.DB, path string) error {
	t.Helper()
	return registry.Register(conn, registry.Entry{
		Path:      path,
		Repo:      "repo",
		RepoRoot:  path,
		Branch:    "br",
		CreatedAt: "2026-01-01T00:00:00Z",
	})
}

func TestWorktreesCarriesUnreadCountOnFocusResources(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := registerWorktreeForTest(t, conn, wt); err != nil {
		t.Fatal(err)
	}
	if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	insertUnreadEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")

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
	if len(got) != 1 || len(got[0].FocusResources) != 1 {
		t.Fatalf("got %d worktrees, want 1 with 1 focus resource", len(got))
	}
	if got[0].FocusResources[0].UnreadCount != 1 {
		t.Fatalf("unread_count = %d, want 1", got[0].FocusResources[0].UnreadCount)
	}
}

func TestTimelineMarksEventsNewerThanTheCursorUnread(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	insertUnreadEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	insertUnreadEvent(t, conn, "e2", "2099-01-02T00:00:00Z", "github", "pr", "o/r#1")
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2099-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktree-timeline?path=" + url.QueryEscape(wt))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got timelineResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	byID := map[string]bool{}
	for _, e := range got.Events {
		byID[e.ID] = e.Unread
	}
	if byID["e2"] != true {
		t.Fatal("e2 is newer than the cursor and must be unread")
	}
	if byID["e1"] != false {
		t.Fatal("e1 is AT the cursor and must be read")
	}
}

func TestTimelineNeverMarksSlackEventsUnread(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := resources.Add(conn, wt, resources.Resource{Type: "slack", ID: "C1:1.2", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	insertUnreadEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "slack", "slack", "C1:1.2")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktree-timeline?path=" + url.QueryEscape(wt))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got timelineResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	for _, e := range got.Events {
		if e.Unread {
			t.Fatal("a slack event must never carry unread; the thread owns that state")
		}
	}
}
