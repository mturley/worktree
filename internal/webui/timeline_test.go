package webui

import (
	"database/sql"
	"encoding/json"
	"fmt"
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

func TestGlobalTimelineDedupesMultiResourceEvent(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	wtPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u2"})

	now := time.Now().UTC()
	// One event linked to TWO watched resources -> two rows in
	// watcher_event_resources for the same event id.
	if _, err := conn.Exec(`INSERT INTO watcher_events (id, ts, source, type, title) VALUES (?,?,?,?,?)`,
		"m1", now.Format(time.RFC3339), "github", "pr_comment", "multi-resource comment"); err != nil {
		t.Fatal(err)
	}
	for _, r := range []struct{ rtype, rid, rurl string }{
		{"pr", "o/r#1", "u1"},
		{"pr", "o/r#2", "u2"},
	} {
		if _, err := conn.Exec(`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id, resource_url) VALUES (?,?,?,?)`,
			"m1", r.rtype, r.rid, r.rurl); err != nil {
			t.Fatal(err)
		}
	}

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/timeline?limit=50&archived=false")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Events []TimelineEvent `json:"events"`
	}
	json.NewDecoder(resp.Body).Decode(&body)

	count := 0
	for _, e := range body.Events {
		if e.ID == "m1" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected event m1 to appear exactly once, got %d occurrences in %+v", count, body.Events)
	}
}

func TestGlobalTimelineBeforeCursor(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	wtPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})

	base := time.Now().UTC()
	t1 := base.Add(-2 * time.Minute).Format(time.RFC3339)
	t2 := base.Add(-1 * time.Minute).Format(time.RFC3339)
	t3 := base.Format(time.RFC3339)
	insertEvent(t, conn, "b1e1", t1, "github", "pr_comment", "first", "pr", "o/r#1", "u1")
	insertEvent(t, conn, "b1e2", t2, "github", "pr_comment", "second", "pr", "o/r#1", "u1")
	insertEvent(t, conn, "b1e3", t3, "github", "pr_comment", "third", "pr", "o/r#1", "u1")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/timeline?archived=false&limit=50&before=" + url.QueryEscape(t3))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Events []TimelineEvent `json:"events"`
	}
	json.NewDecoder(resp.Body).Decode(&body)

	if len(body.Events) != 2 {
		t.Fatalf("expected 2 events before t3, got %d: %+v", len(body.Events), body.Events)
	}
	if body.Events[0].ID != "b1e2" || body.Events[1].ID != "b1e1" {
		t.Fatalf("expected newest-first order [b1e2, b1e1], got %+v", body.Events)
	}
	for _, e := range body.Events {
		if e.ID == "b1e3" {
			t.Fatalf("event b1e3 (the before cursor itself) should be excluded, got %+v", body.Events)
		}
	}
}

var _ = watcher.Resource{}
var _ = watcherdb.EventsForSubscriberSince

func TestWorktreeTimelineResourceFilter(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	wtPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})
	resources.Add(conn, wtPath, resources.Resource{Type: "jira", ID: "J-1", URL: "u2"})

	// Interleave 5 matching and 5 non-matching events so that a naive
	// "limit first, filter second" implementation would return fewer than 5.
	base := time.Now().UTC().Add(-time.Hour)
	for i := 0; i < 5; i++ {
		insertEvent(t, conn, fmt.Sprintf("pr-%d", i), base.Add(time.Duration(i*2)*time.Minute).Format(time.RFC3339),
			"github", "pr_comment", fmt.Sprintf("pr comment %d", i), "pr", "o/r#1", "u1")
		insertEvent(t, conn, fmt.Sprintf("jira-%d", i), base.Add(time.Duration(i*2+1)*time.Minute).Format(time.RFC3339),
			"jira", "jira_comment", fmt.Sprintf("jira comment %d", i), "jira", "J-1", "u2")
	}

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	get := func(query string) (int, []TimelineEvent) {
		resp, err := http.Get(ts.URL + "/api/worktree-timeline?path=" + url.QueryEscape(wtPath) + query)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body struct {
			Events []TimelineEvent `json:"events"`
		}
		json.NewDecoder(resp.Body).Decode(&body)
		return resp.StatusCode, body.Events
	}

	// Unfiltered: all 10 events.
	if _, evs := get(""); len(evs) != 10 {
		t.Fatalf("unfiltered: want 10 events, got %d", len(evs))
	}

	// Filtered: only the PR's events.
	code, evs := get("&resource_type=pr&resource_id=" + url.QueryEscape("o/r#1"))
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
	if len(evs) != 5 {
		t.Fatalf("filtered: want 5 pr events, got %d", len(evs))
	}
	for _, e := range evs {
		if e.ResourceType != "pr" || e.ResourceID != "o/r#1" {
			t.Fatalf("filter leaked a non-matching event: %+v", e)
		}
	}

	// The filter must be applied BEFORE the limit: with limit=3 we must get
	// 3 matching events, not "3 newest overall, then filtered down".
	_, limited := get("&limit=3&resource_type=pr&resource_id=" + url.QueryEscape("o/r#1"))
	if len(limited) != 3 {
		t.Fatalf("want 3 matching events under limit=3, got %d", len(limited))
	}
	for _, e := range limited {
		if e.ResourceType != "pr" {
			t.Fatalf("limited filter leaked: %+v", e)
		}
	}

	// A half-specified filter is a client error, not a silent unfiltered page.
	if code, _ := get("&resource_type=pr"); code != http.StatusBadRequest {
		t.Fatalf("resource_type without resource_id: want 400, got %d", code)
	}
	if code, _ := get("&resource_id=" + url.QueryEscape("o/r#1")); code != http.StatusBadRequest {
		t.Fatalf("resource_id without resource_type: want 400, got %d", code)
	}
}

func TestWorktreeTimelineBeforeCursorPaginates(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	wtPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})

	base := time.Now().UTC()
	t1 := base.Add(-3 * time.Minute).Format(time.RFC3339)
	t2 := base.Add(-2 * time.Minute).Format(time.RFC3339)
	t3 := base.Add(-1 * time.Minute).Format(time.RFC3339)
	insertEvent(t, conn, "w1", t1, "github", "pr_comment", "first", "pr", "o/r#1", "u1")
	insertEvent(t, conn, "w2", t2, "github", "pr_comment", "second", "pr", "o/r#1", "u1")
	insertEvent(t, conn, "w3", t3, "github", "pr_comment", "third", "pr", "o/r#1", "u1")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	get := func(q string) (events []TimelineEvent, cursor string) {
		resp, err := http.Get(ts.URL + "/api/worktree-timeline?path=" + url.QueryEscape(wtPath) + q)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body struct {
			Events     []TimelineEvent `json:"events"`
			NextCursor string          `json:"next_cursor"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return body.Events, body.NextCursor
	}

	// First page: newest event only, and a cursor pointing at it.
	page1, cursor := get("&limit=1")
	if len(page1) != 1 || page1[0].ID != "w3" {
		t.Fatalf("page 1 = %+v, want [w3]", page1)
	}
	if cursor == "" {
		t.Fatal("page 1 returned no next_cursor, so there is no way to ask for page 2")
	}

	// Second page continues from the cursor and must not repeat the event
	// the cursor names — an off-by-one here shows up as a duplicated row in
	// the feed every time the user clicks "load more".
	page2, _ := get("&limit=1&before=" + url.QueryEscape(cursor))
	if len(page2) != 1 || page2[0].ID != "w2" {
		t.Fatalf("page 2 = %+v, want [w2]", page2)
	}

	// The cursor still applies when a resource filter is active: the filter
	// runs in the same in-memory loop, so a naive implementation can drop
	// the cursor for filtered feeds only.
	filtered, _ := get("&limit=10&resource_type=pr&resource_id=" + url.QueryEscape("o/r#1") + "&before=" + url.QueryEscape(t3))
	if len(filtered) != 2 {
		t.Fatalf("filtered+before = %+v, want 2 events (w2, w1)", filtered)
	}
	for _, e := range filtered {
		if e.ID == "w3" {
			t.Fatalf("before cursor ignored under a resource filter: %+v", filtered)
		}
	}
}

// TestEnricherIsRequestScoped pins the lifetime contract that makes the
// enricher's memoisation safe WITHOUT any invalidation logic: it caches for
// one request, and a fresh one sees changes made since.
//
// This matters because titles and subscriptions are changed by writers this
// server cannot observe — the poller, and `worktree` CLI invocations in other
// processes. A longer-lived cache would need invalidation hooks it cannot have.
func TestEnricherIsRequestScoped(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	wtPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})
	if err := watcherdb.UpsertResourceState(conn, "pr", "o/r#1",
		`{"title":"before"}`, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}

	srv := &Server{DB: conn}

	// Within one enricher, repeated lookups are one consistent snapshot.
	e1 := srv.newEventEnricher()
	if got := e1.resourceTitle("pr", "o/r#1"); got != "before" {
		t.Fatalf("title = %q, want %q", got, "before")
	}
	if err := watcherdb.UpsertResourceState(conn, "pr", "o/r#1",
		`{"title":"after"}`, "2026-08-02T00:00:00Z", "2026-08-02T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if got := e1.resourceTitle("pr", "o/r#1"); got != "before" {
		t.Fatalf("mid-request title = %q; a page should render one snapshot, not a mix", got)
	}

	// The next request picks the change up with no invalidation call.
	if got := srv.newEventEnricher().resourceTitle("pr", "o/r#1"); got != "after" {
		t.Fatalf("next-request title = %q, want %q — the memo outlived its request", got, "after")
	}
}

// TestEnricherSeesSubscriptionChangesNextRequest is the same contract for the
// other memo: worktree attribution.
func TestEnricherSeesSubscriptionChangesNextRequest(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	wtPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})

	srv := &Server{DB: conn}
	if got := srv.newEventEnricher().worktreesWatching("pr", "o/r#1"); len(got) != 1 || got[0].Branch != "b1" || got[0].Path != wtPath {
		t.Fatalf("watching = %+v, want one entry {b1, %s}", got, wtPath)
	}

	// Unsubscribing is visible to the next request without invalidation.
	if err := resources.Remove(conn, wtPath, "pr", "o/r#1"); err != nil {
		t.Fatal(err)
	}
	if got := srv.newEventEnricher().worktreesWatching("pr", "o/r#1"); len(got) != 0 {
		t.Fatalf("watching after unsubscribe = %v, want []", got)
	}
}

// TestTimelineCarriesWorktreePaths pins the path alongside the branch. The UI
// routes by path, and branch names are not unique across repos, so it cannot
// derive one from the other.
func TestTimelineCarriesWorktreePaths(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	wtPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})
	insertEvent(t, conn, "e1", time.Now().UTC().Format(time.RFC3339), "github", "pr_comment", "hi", "pr", "o/r#1", "u1")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/timeline?archived=false&limit=10")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Events []TimelineEvent `json:"events"`
	}
	json.NewDecoder(resp.Body).Decode(&body)
	if len(body.Events) != 1 {
		t.Fatalf("want 1 event, got %d", len(body.Events))
	}
	got := body.Events[0]
	if len(got.Worktrees) != 1 || got.Worktrees[0] != "b1" {
		t.Fatalf("worktrees = %v, want [b1]", got.Worktrees)
	}
	// Same order, so the UI can pair them index-wise.
	if len(got.WorktreePaths) != 1 || got.WorktreePaths[0] != wtPath {
		t.Fatalf("worktree_paths = %v, want [%s]", got.WorktreePaths, wtPath)
	}
}
