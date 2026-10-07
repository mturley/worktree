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
	// Mark-all-read sends this as through_ts, so it must be the newest of
	// exactly the events unread_count counted.
	if got[0].UnreadThroughTS != "2099-01-02T00:00:00Z" {
		t.Fatalf("unread_through_ts = %q, want the newest unread event's ts", got[0].UnreadThroughTS)
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
	if !ix.IsUnread("slack", thread, rowTS, "3000.000000", "slack", "") {
		t.Fatal("reply newer than Slack's cursor should be unread")
	}
	if ix.IsUnread("slack", thread, rowTS, "1500.000000", "slack", "") {
		t.Fatal("reply older than Slack's cursor should be read")
	}
	if ix.IsUnread("slack", thread, rowTS, "", "slack", "") {
		t.Fatal("event with no external ts has nothing to compare; should be read")
	}
	if ix.IsUnread("slack", "C1:9999.000000", rowTS, "3000.000000", "slack", "") {
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

// TestWorktreeSummaryCountsASlackOnlyUnread: a Slack-only unread used to
// leave the count at 0 with has_unread set, because Slack threads had no
// tally. They do now, and an unread thread counts at least 1 even with no
// recorded replies behind its cursor — so the badge always has a number.
func TestWorktreeSummaryCountsASlackOnlyUnread(t *testing.T) {
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
		if w.UnreadCount != 1 {
			t.Fatalf("unread_count = %d, want 1 — an unread thread with no recorded replies still counts", w.UnreadCount)
		}
		return
	}
	t.Fatalf("worktree %s absent from the summary", wt)
}

func insertSlackStateUnread(t *testing.T, conn *sql.DB, resID, lastRead string, hasUnread bool) {
	t.Helper()
	hu := "false"
	if hasUnread {
		hu = "true"
	}
	state := `{"title":"t","has_unread":` + hu + `,"last_read":"` + lastRead + `"}`
	if _, err := conn.Exec(
		`INSERT INTO watcher_resource_state
			(resource_type, resource_id, state_json, resource_updated_at, watcher_updated_at)
		 VALUES ('slack', ?, ?, '', '2099-01-01T00:00:00Z')`,
		resID, state); err != nil {
		t.Fatal(err)
	}
}

func getResources(t *testing.T, base, path string) map[string]resourceDTO {
	t.Helper()
	resp, err := http.Get(base + "/api/worktree-resources?path=" + url.QueryEscape(path))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []resourceDTO
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	out := map[string]resourceDTO{}
	for _, r := range got {
		out[r.ID] = r
	}
	return out
}

// Slack threads carry unread_count like every other resource: the replies
// newer than Slack's cursor, as the timelines mark them.
//
// It is tied to has_unread so the count and the dot can never disagree:
// a thread Slack calls read counts 0 whatever events say, and a thread Slack
// calls unread counts at least 1 even when none of its unread messages were
// recorded as events (an unread root, say) — a dot with no number would read
// as a bug.
func TestSlackThreadsCarryUnreadCountTiedToHasUnread(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := registerWorktreeForTest(t, conn, wt); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"C1:1.0", "C2:1.0", "C3:1.0"} {
		if err := resources.Add(conn, wt, resources.Resource{Type: "slack", ID: id, URL: "u"}); err != nil {
			t.Fatal(err)
		}
	}
	// C1: unread, two recorded replies after the cursor.
	insertSlackStateUnread(t, conn, "C1:1.0", "2000.000000", true)
	insertSlackEvent(t, conn, "a", "2099-01-02T00:00:00Z", "3000.000000", "C1:1.0")
	insertSlackEvent(t, conn, "b", "2099-01-03T00:00:00Z", "4000.000000", "C1:1.0")
	// C2: unread, but nothing recorded after the cursor.
	insertSlackStateUnread(t, conn, "C2:1.0", "2000.000000", true)
	insertSlackEvent(t, conn, "c", "2099-01-02T00:00:00Z", "1500.000000", "C2:1.0")
	// C3: Slack says read, though an event sits after a stale cursor.
	insertSlackStateUnread(t, conn, "C3:1.0", "2000.000000", false)
	insertSlackEvent(t, conn, "d", "2099-01-02T00:00:00Z", "3000.000000", "C3:1.0")

	ts := httptest.NewServer((&Server{DB: conn}).Handler())
	defer ts.Close()

	got := getResources(t, ts.URL, wt)
	for id, want := range map[string]int{"C1:1.0": 2, "C2:1.0": 1, "C3:1.0": 0} {
		if n := got[id].UnreadCount; n != want {
			t.Errorf("%s unread_count = %d, want %d", id, n, want)
		}
	}

	// The worktree total sums them like any other resource's.
	resp, err := http.Get(ts.URL + "/api/worktrees")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var wts []worktreeSummary
	if err := json.NewDecoder(resp.Body).Decode(&wts); err != nil {
		t.Fatal(err)
	}
	if len(wts) != 1 || wts[0].UnreadCount != 3 || !wts[0].HasUnread {
		t.Fatalf("worktree = %+v, want unread_count 3 with has_unread", wts)
	}
}

func TestIsUnreadIgnoresMyOwnEvents(t *testing.T) {
	ix := &unreadIndex{cursors: map[string]string{unread.Key("pr", "o/r#1"): "2026-01-01T00:00:00Z"},
		mine: map[string]string{"github": "101"}}
	if ix.IsUnread("pr", "o/r#1", "2026-01-01T00:00:05Z", "", "github", "101") {
		t.Fatal("the user's own event must not be unread")
	}
	if !ix.IsUnread("pr", "o/r#1", "2026-01-01T00:00:05Z", "", "github", "202") {
		t.Fatal("another person's newer event must be unread")
	}
	if !ix.IsUnread("pr", "o/r#1", "2026-01-01T00:00:05Z", "", "jira", "101") {
		t.Fatal("the same id under another source is someone else")
	}
}
