package webui

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

// insertEvent is a test helper writing directly to the watcher tables.
func insertEvent(t *testing.T, db *sql.DB, id, ts, source, typ, title, rtype, rid, rurl string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO watcher_events (id, ts, source, type, title) VALUES (?,?,?,?,?)`,
		id, ts, source, typ, title); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id, resource_url) VALUES (?,?,?,?)`,
		id, rtype, rid, rurl); err != nil {
		t.Fatal(err)
	}
}

func TestGlobalTimelineArchivedToggle(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	wtPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})

	now := time.Now().UTC()
	// watched resource event
	insertEvent(t, conn, "e1", now.Format(time.RFC3339), "github", "pr_comment", "watched comment", "pr", "o/r#1", "u1")
	// event for a resource NOT watched by anyone (archived)
	insertEvent(t, conn, "e2", now.Add(-time.Minute).Format(time.RFC3339), "github", "pr_comment", "orphan comment", "pr", "o/r#999", "u9")
	// bookkeeping event must always be excluded
	insertEvent(t, conn, "e3", now.Add(time.Minute).Format(time.RFC3339), "github", "watch_started", "noise", "pr", "o/r#1", "u1")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	get := func(archived bool) []TimelineEvent {
		u := ts.URL + "/api/timeline?limit=50&archived=" + url.QueryEscape(boolStr(archived))
		resp, err := http.Get(u)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body struct {
			Events []TimelineEvent `json:"events"`
		}
		json.NewDecoder(resp.Body).Decode(&body)
		return body.Events
	}

	notArchived := get(false)
	if len(notArchived) != 1 || notArchived[0].ID != "e1" {
		t.Fatalf("archived=false should show only watched non-bookkeeping events, got %+v", notArchived)
	}
	if len(notArchived[0].Worktrees) != 1 || notArchived[0].Worktrees[0] != "b1" {
		t.Fatalf("event should be attributed to worktree b1, got %+v", notArchived[0].Worktrees)
	}
	withArchived := get(true)
	if len(withArchived) != 2 {
		t.Fatalf("archived=true should include the orphan event too, got %d", len(withArchived))
	}
	// newest first
	if withArchived[0].ID != "e1" {
		t.Fatalf("expected newest-first ordering, got %+v", withArchived)
	}
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func TestWorktreeScopedTimeline(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wtPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})
	now := time.Now().UTC()
	insertEvent(t, conn, "s1", now.Format(time.RFC3339), "github", "pr_comment", "mine", "pr", "o/r#1", "u1")
	insertEvent(t, conn, "s2", now.Format(time.RFC3339), "github", "pr_comment", "not mine", "pr", "o/r#2", "u2")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktree-timeline?path=" + url.QueryEscape(wtPath))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Events []TimelineEvent `json:"events"`
	}
	json.NewDecoder(resp.Body).Decode(&body)
	if len(body.Events) != 1 || body.Events[0].ID != "s1" {
		t.Fatalf("scoped timeline should show only this worktree's resource events, got %+v", body.Events)
	}
}

var _ = watcher.Resource{}
var _ = watcherdb.EventsForSubscriberSince
