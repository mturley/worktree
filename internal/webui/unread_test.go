package webui

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
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

func postResourceRead(t *testing.T, base, body string) *http.Response {
	t.Helper()
	resp, err := http.Post(base+"/api/resource-read", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestResourceReadMarksThroughTheClientsTimestamp(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	insertUnreadEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	insertUnreadEvent(t, conn, "e2", "2099-01-02T00:00:00Z", "github", "pr", "o/r#1")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// The client saw only e1. e2 arrived after render and must survive.
	resp := postResourceRead(t, ts.URL,
		`{"type":"pr","id":"o/r#1","through_ts":"2099-01-01T00:00:00Z"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.StatusCode)
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#1")]; n != 1 {
		t.Fatalf("unread = %d, want 1 — an event newer than through_ts must survive the mark", n)
	}
}

func TestResourceReadRejectsSlack(t *testing.T) {
	conn := unreadTestDB(t)
	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := postResourceRead(t, ts.URL, `{"type":"slack","id":"C1:1.2","through_ts":"1.0"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestResourceReadRequiresTypeIDAndThroughTS(t *testing.T) {
	conn := unreadTestDB(t)
	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	for _, body := range []string{
		`{"id":"o/r#1","through_ts":"2099-01-01T00:00:00Z"}`,
		`{"type":"pr","through_ts":"2099-01-01T00:00:00Z"}`,
		`{"type":"pr","id":"o/r#1"}`,
	} {
		resp := postResourceRead(t, ts.URL, body)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400", body, resp.StatusCode)
		}
		resp.Body.Close()
	}
}

// insertSlackState writes the poller-cached state a Slack thread would have
// after a poll, carrying the read cursor the unread comparison needs.
func insertSlackState(t *testing.T, conn *sql.DB, resID, lastRead string) {
	t.Helper()
	state := `{"title":"t","has_unread":true,"last_read":"` + lastRead + `"}`
	if _, err := conn.Exec(
		`INSERT INTO watcher_resource_state
			(resource_type, resource_id, state_json, resource_updated_at, watcher_updated_at)
		 VALUES ('slack', ?, ?, '', '2099-01-01T00:00:00Z')`,
		resID, state); err != nil {
		t.Fatal(err)
	}
}

func insertSlackEvent(t *testing.T, conn *sql.DB, id, ts, externalTS, resID string) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO watcher_events (id, ts, external_ts, source, type, title)
		 VALUES (?, ?, ?, 'slack', 'slack_reply', 'x')`,
		id, ts, externalTS); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id)
		 VALUES (?, 'slack', ?)`, id, resID); err != nil {
		t.Fatal(err)
	}
}

// TestIsUnreadUsesSlacksOwnCursor is the whole point of caching last_read: a
// Slack reply newer than Slack's read cursor is unread, and one older is not.
// Before the cursor was cached this was hard-false for every Slack event.
func TestIsUnreadUsesSlacksOwnCursor(t *testing.T) {
	conn := unreadTestDB(t)
	const thread = "C1:1000.000100"
	insertSlackState(t, conn, thread, "2000.000000")

	srv := &Server{DB: conn}
	ix := srv.newUnreadIndex()

	// The event row's own ts is deliberately the SAME on both, so a passing
	// test can only be reading external_ts — the Slack clock.
	const rowTS = "2099-01-01T00:00:00Z"
	if !ix.IsUnread("slack", thread, rowTS, "3000.000000") {
		t.Fatal("reply newer than Slack's cursor should be unread")
	}
	if ix.IsUnread("slack", thread, rowTS, "1500.000000") {
		t.Fatal("reply older than Slack's cursor should be read")
	}
	if ix.IsUnread("slack", thread, rowTS, "") {
		t.Fatal("event with no external ts has nothing to compare; should be read")
	}
	if ix.IsUnread("slack", "C1:9999.000000", rowTS, "3000.000000") {
		t.Fatal("thread with no cached cursor should be read, not unread")
	}
}

// TestSlackTSGreaterIsNumeric guards the digit-growth case a string compare
// gets wrong: "9999999999.x" is lexically above "10000000000.x" but earlier
// in time.
func TestSlackTSGreaterIsNumeric(t *testing.T) {
	if !slackTSGreater("10000000000.000000", "9999999999.999999") {
		t.Fatal("a later ts with more digits must compare greater")
	}
	if slackTSGreater("1788464505.422459", "1788464505.422459") {
		t.Fatal("an equal ts is not greater — the cursor's own message is read")
	}
	if slackTSGreater("not-a-ts", "1788464505.422459") {
		t.Fatal("unparseable ts must not read as unread")
	}
}

// TestSlackTimelineEventsCarryUnread walks the whole path the UI sees: cached
// poller state -> SlackCursors -> the timeline DTO's unread flag.
func TestSlackTimelineEventsCarryUnread(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	const thread = "C1:1000.000100"
	if err := resources.Add(conn, wt, resources.Resource{Type: "slack", ID: thread, URL: "u"}); err != nil {
		t.Fatal(err)
	}
	insertSlackState(t, conn, thread, "2000.000000")
	insertSlackEvent(t, conn, "s1", "2099-01-02T00:00:00Z", "3000.000000", thread)
	insertSlackEvent(t, conn, "s2", "2099-01-03T00:00:00Z", "1500.000000", thread)

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktree-timeline?path=" + url.QueryEscape(wt))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out timelineResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, e := range out.Events {
		seen[e.ID] = e.Unread
	}
	if len(seen) != 2 {
		t.Fatalf("want both slack events in the feed, got %d: %+v", len(seen), seen)
	}
	if !seen["s1"] {
		t.Fatal("reply after Slack's cursor should be marked unread in the timeline")
	}
	if seen["s2"] {
		t.Fatal("reply before Slack's cursor should not be marked unread")
	}
}

// TestWorktreeSummaryHasUnreadIncludesRelated is the reason the aggregate is
// computed server-side at all: related resources are counted in the response
// but never listed, so a client folding over focus_resources cannot see their
// unreads. The card accent would silently miss them.
func TestWorktreeSummaryHasUnreadIncludesRelated(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := registerWorktreeForTest(t, conn, wt); err != nil {
		t.Fatal(err)
	}
	if err := resources.Add(conn, wt, resources.Resource{
		Type: "pr", ID: "o/r#1", URL: "u", Related: true,
	}); err != nil {
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
	var out []worktreeSummary
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	for _, w := range out {
		if w.Path != wt {
			continue
		}
		if len(w.FocusResources) != 0 {
			t.Fatalf("resource should be related, not focus: %+v", w.FocusResources)
		}
		if !w.HasUnread {
			t.Fatal("unread on a RELATED resource must still light the worktree")
		}
		return
	}
	t.Fatalf("worktree %s absent from the summary", wt)
}

// TestWorktreeSummaryHasUnreadFalseWhenRead guards the other direction: the
// accent is a claim, and a card wearing it with nothing new inside teaches
// the user to ignore it.
func TestWorktreeSummaryHasUnreadFalseWhenRead(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := registerWorktreeForTest(t, conn, wt); err != nil {
		t.Fatal(err)
	}
	if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	// resources.Add seeds the cursor at the newest event, so a resource whose
	// events all predate it reads as fully read.
	insertUnreadEvent(t, conn, "e1", "2000-01-01T00:00:00Z", "github", "pr", "o/r#2")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktrees")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out []worktreeSummary
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	for _, w := range out {
		if w.Path == wt && w.HasUnread {
			t.Fatal("a fully read worktree must not claim unread")
		}
	}
}

// TestWorktreeSummaryUnreadCountSumsAllResources pins the badge's number.
// Unlike HasUnread, the count cannot stop at the first unread resource — a
// short-circuit there would undercount the badge on every worktree with more
// than one busy resource.
func TestWorktreeSummaryUnreadCountSumsAllResources(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := registerWorktreeForTest(t, conn, wt); err != nil {
		t.Fatal(err)
	}
	// One focus resource and one RELATED resource, both unread: the related
	// one is never listed in the response, so only the total can reveal it.
	if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	if err := resources.Add(conn, wt, resources.Resource{
		Type: "jira", ID: "J-1", URL: "u", Related: true,
	}); err != nil {
		t.Fatal(err)
	}
	insertUnreadEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	insertUnreadEvent(t, conn, "e2", "2099-01-02T00:00:00Z", "github", "pr", "o/r#1")
	insertUnreadEvent(t, conn, "e3", "2099-01-03T00:00:00Z", "jira", "jira", "J-1")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktrees")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out []worktreeSummary
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	for _, w := range out {
		if w.Path != wt {
			continue
		}
		if w.UnreadCount != 3 {
			t.Fatalf("unread_count = %d, want 3 (2 focus + 1 related)", w.UnreadCount)
		}
		if !w.HasUnread {
			t.Fatal("a worktree with unread events must also report has_unread")
		}
		return
	}
	t.Fatalf("worktree %s absent from the summary", wt)
}

// TestWorktreeSummaryUnreadCountZeroForSlackOnly is the case the badge's copy
// exists for: a Slack thread is unread without a countable tally behind it,
// so the flag says yes while the number says nothing.
func TestWorktreeSummaryUnreadCountZeroForSlackOnly(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := registerWorktreeForTest(t, conn, wt); err != nil {
		t.Fatal(err)
	}
	const thread = "C1:1000.000100"
	if err := resources.Add(conn, wt, resources.Resource{Type: "slack", ID: thread, URL: "u"}); err != nil {
		t.Fatal(err)
	}
	insertSlackState(t, conn, thread, "2000.000000") // has_unread: true

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktrees")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out []worktreeSummary
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	for _, w := range out {
		if w.Path != wt {
			continue
		}
		if !w.HasUnread {
			t.Fatal("an unread Slack thread must set has_unread")
		}
		if w.UnreadCount != 0 {
			t.Fatalf("unread_count = %d, want 0 — Slack has no countable tally", w.UnreadCount)
		}
		return
	}
	t.Fatalf("worktree %s absent from the summary", wt)
}
