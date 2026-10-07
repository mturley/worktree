package webui

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"testing"

	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/selfid"
	"github.com/mturley/worktree/internal/testgit"
	"github.com/mturley/worktree/internal/unread"
)

// unreadOnlyFixture builds one worktree tracking every case the unread-only
// filter has to agree with IsUnread on:
//
//   - pr o/r#1: cursor between its events, so p1 is read and p2, p3 unread
//   - jira J-1: never seeded (no cursor row), so j1 reads as read
//   - slack thread: Slack's cursor between its replies, so s1 is unread and
//     s2 read even though s2 is NEWER by row ts — the Slack clock decides
//   - slack thread with no cached cursor: s3 reads as read
//   - a bookkeeping event newer than the pr cursor, which no feed renders
func unreadOnlyFixture(t *testing.T) (*sql.DB, string) {
	t.Helper()
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	for _, r := range []resources.Resource{
		{Type: "pr", ID: "o/r#1", URL: "u"},
		{Type: "slack", ID: "C1:1000.000100", URL: "u"},
		{Type: "slack", ID: "C2:1000.000100", URL: "u"},
	} {
		if err := resources.Add(conn, wt, r); err != nil {
			t.Fatal(err)
		}
	}
	// Jira is subscribed without a cursor row: Add seeds one, so drop it.
	if err := resources.Add(conn, wt, resources.Resource{Type: "jira", ID: "J-1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`DELETE FROM resource_read_cursor WHERE resource_type = 'jira'`); err != nil {
		t.Fatal(err)
	}

	insertUnreadEvent(t, conn, "p1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	insertUnreadEvent(t, conn, "p2", "2099-01-03T00:00:00Z", "github", "pr", "o/r#1")
	insertUnreadEvent(t, conn, "p3", "2099-01-05T00:00:00Z", "github", "pr", "o/r#1")
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2099-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO watcher_events (id, ts, source, type, title) VALUES ('b1', '2099-01-07T00:00:00Z', 'github', 'watcher_error', 'x')`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id) VALUES ('b1', 'pr', 'o/r#1')`); err != nil {
		t.Fatal(err)
	}

	insertUnreadEvent(t, conn, "j1", "2099-01-02T00:00:00Z", "jira", "jira", "J-1")

	insertSlackState(t, conn, "C1:1000.000100", "2000.000000")
	insertSlackEvent(t, conn, "s1", "2099-01-04T00:00:00Z", "3000.000000", "C1:1000.000100")
	insertSlackEvent(t, conn, "s2", "2099-01-06T00:00:00Z", "1500.000000", "C1:1000.000100")
	insertSlackEvent(t, conn, "s3", "2099-01-08T00:00:00Z", "3000.000000", "C2:1000.000100")
	return conn, wt
}

func getTimeline(t *testing.T, base, path string) timelineResponse {
	t.Helper()
	resp, err := http.Get(base + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: status %d", path, resp.StatusCode)
	}
	var out timelineResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func eventIDs(evs []TimelineEvent) []string {
	ids := make([]string, 0, len(evs))
	for _, e := range evs {
		ids = append(ids, e.ID)
	}
	return ids
}

func unreadIDs(evs []TimelineEvent) []string {
	ids := []string{}
	for _, e := range evs {
		if e.Unread {
			ids = append(ids, e.ID)
		}
	}
	return ids
}

func sameIDs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// The SQL predicate in the global timeline is a second implementation of
// IsUnread. This pins them together: on the same data, unread_only must
// return exactly the events the unfiltered feed flags unread, in feed order.
func TestGlobalTimelineUnreadOnlyMatchesIsUnread(t *testing.T) {
	conn, _ := unreadOnlyFixture(t)
	ts := httptest.NewServer((&Server{DB: conn}).Handler())
	defer ts.Close()

	all := getTimeline(t, ts.URL, "/api/timeline?limit=100")
	only := getTimeline(t, ts.URL, "/api/timeline?limit=100&unread_only=true")

	want := []string{"p3", "s1", "p2"}
	if got := unreadIDs(all.Events); !sameIDs(got, want) {
		t.Fatalf("fixture sanity: unfiltered unread = %v, want %v", got, want)
	}
	if got := eventIDs(only.Events); !sameIDs(got, want) {
		t.Fatalf("unread_only = %v, want %v (the unfiltered feed's unread events)", got, want)
	}
	for _, e := range only.Events {
		if !e.Unread {
			t.Fatalf("%s returned by unread_only but not flagged unread", e.ID)
		}
	}
}

func TestWorktreeTimelineUnreadOnlyMatchesIsUnread(t *testing.T) {
	conn, wt := unreadOnlyFixture(t)
	ts := httptest.NewServer((&Server{DB: conn}).Handler())
	defer ts.Close()

	base := "/api/worktree-timeline?limit=100&path=" + url.QueryEscape(wt)
	all := getTimeline(t, ts.URL, base)
	only := getTimeline(t, ts.URL, base+"&unread_only=true")
	if got, want := eventIDs(only.Events), unreadIDs(all.Events); !sameIDs(got, want) || len(want) != 3 {
		t.Fatalf("unread_only = %v, want the unfiltered feed's unread events %v", got, want)
	}
}

// Filtering must happen BEFORE the page limit, or a page of read events comes
// back empty and paging stops early. Walk both feeds one event at a time.
func TestUnreadOnlyPagesFullyThroughUnreadEvents(t *testing.T) {
	conn, wt := unreadOnlyFixture(t)
	ts := httptest.NewServer((&Server{DB: conn}).Handler())
	defer ts.Close()

	for name, base := range map[string]string{
		"global":   "/api/timeline?limit=1&unread_only=true",
		"worktree": "/api/worktree-timeline?limit=1&unread_only=true&path=" + url.QueryEscape(wt),
	} {
		var got []string
		before := ""
		for i := 0; i < 10; i++ {
			q := base
			if before != "" {
				q += "&before=" + url.QueryEscape(before)
			}
			page := getTimeline(t, ts.URL, q)
			if len(page.Events) == 0 {
				break
			}
			got = append(got, eventIDs(page.Events)...)
			before = page.NextCursor
		}
		if want := []string{"p3", "s1", "p2"}; !sameIDs(got, want) {
			t.Fatalf("%s: paged unread_only = %v, want %v", name, got, want)
		}
	}
}

// Combines with the source filter rather than replacing it.
func TestUnreadOnlyCombinesWithResourceTypes(t *testing.T) {
	conn, _ := unreadOnlyFixture(t)
	ts := httptest.NewServer((&Server{DB: conn}).Handler())
	defer ts.Close()
	got := eventIDs(getTimeline(t, ts.URL, "/api/timeline?limit=100&unread_only=true&resource_types=slack").Events)
	sort.Strings(got)
	if want := []string{"s1"}; !sameIDs(got, want) {
		t.Fatalf("unread_only + slack = %v, want %v", got, want)
	}
}

// The user's own events (internal/selfid) are never unread, in either
// implementation: the unread_only SQL and IsUnread must still agree.
func TestTimelinesNeverFlagMyOwnEventsUnread(t *testing.T) {
	conn, wt := unreadOnlyFixture(t)
	if err := selfid.Set(conn, "github", "101"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`UPDATE watcher_events SET author_id = '101' WHERE id = 'p3'`); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer((&Server{DB: conn}).Handler())
	defer ts.Close()

	want := []string{"s1", "p2"}
	all := getTimeline(t, ts.URL, "/api/timeline?limit=100")
	only := getTimeline(t, ts.URL, "/api/timeline?limit=100&unread_only=true")
	if got := unreadIDs(all.Events); !sameIDs(got, want) {
		t.Fatalf("global unread flags = %v, want %v", got, want)
	}
	if got := eventIDs(only.Events); !sameIDs(got, want) {
		t.Fatalf("global unread_only = %v, want %v", got, want)
	}

	base := "/api/worktree-timeline?limit=100&path=" + url.QueryEscape(wt)
	wAll := getTimeline(t, ts.URL, base)
	wOnly := getTimeline(t, ts.URL, base+"&unread_only=true")
	if got := unreadIDs(wAll.Events); !sameIDs(got, want) {
		t.Fatalf("worktree unread flags = %v, want %v", got, want)
	}
	if got := eventIDs(wOnly.Events); !sameIDs(got, want) {
		t.Fatalf("worktree unread_only = %v, want %v", got, want)
	}

	// "Mark N as read" covers only the other person's newest event.
	resp, err := http.Get(ts.URL + "/api/worktree-resources?path=" + url.QueryEscape(wt))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var rs []resourceDTO
	json.NewDecoder(resp.Body).Decode(&rs)
	for _, r := range rs {
		if r.Type == "pr" {
			if r.UnreadCount != 1 || r.UnreadThroughTS != "2099-01-03T00:00:00Z" {
				t.Fatalf("pr unread = %d through %q, want 1 through p2", r.UnreadCount, r.UnreadThroughTS)
			}
			return
		}
	}
	t.Fatal("pr resource missing")
}
