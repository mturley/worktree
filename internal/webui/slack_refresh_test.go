package webui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/mturley/watcher"
	"github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
)

// recordRefresh swaps in a refresh seam that records which threads were
// re-polled, so the handlers can be tested without Slack credentials.
func recordRefresh(srv *Server) func() []string {
	var mu sync.Mutex
	var got []string
	srv.pollSlackResource = func(r watcher.Resource) {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, r.ID+" "+r.URL)
	}
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), got...)
	}
}

func postJSON(t *testing.T, url, body string) int {
	t.Helper()
	resp, err := http.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

// The cached has_unread/last_read drive every unread surface except the
// thread view itself. A mark that only wrote to Slack left them stale until
// the next background poll, so the thread is re-polled before responding.
func TestSlackMarkReadAndUnreadRefreshATrackedThread(t *testing.T) {
	t.Parallel()
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := resources.Add(conn, wt, resources.Resource{Type: "slack", ID: "C1:1.0", URL: "https://acme.slack.com/archives/C1/p1"}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/thread/mark-read", "/api/thread/mark-unread"} {
		srv := &Server{DB: conn, SlackClient: newFakeSlack()}
		refreshed := recordRefresh(srv)
		ts := httptest.NewServer(srv.Handler())
		if code := postJSON(t, ts.URL+path, `{"channel":"C1","thread_ts":"1.0","ts":"2.0"}`); code != http.StatusNoContent {
			t.Fatalf("%s: status %d", path, code)
		}
		ts.Close()
		if got := refreshed(); len(got) != 1 || got[0] != "C1:1.0 https://acme.slack.com/archives/C1/p1" {
			t.Fatalf("%s: refreshed %v, want the tracked thread once", path, got)
		}
	}
}

func TestSlackMarkReadSkipsRefreshForUntrackedThread(t *testing.T) {
	t.Parallel()
	conn := unreadTestDB(t)
	srv := &Server{DB: conn, SlackClient: newFakeSlack()}
	refreshed := recordRefresh(srv)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	if code := postJSON(t, ts.URL+"/api/thread/mark-read", `{"channel":"C9","thread_ts":"1.0","ts":"2.0"}`); code != http.StatusNoContent {
		t.Fatalf("status %d", code)
	}
	if got := refreshed(); len(got) != 0 {
		t.Fatalf("refreshed %v for a thread no worktree tracks", got)
	}
}

func TestSlackMarkReadFailureDoesNotRefresh(t *testing.T) {
	t.Parallel()
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := resources.Add(conn, wt, resources.Resource{Type: "slack", ID: "C1:1.0", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	fake := newFakeSlack()
	fake.markReadFailN = 1000
	srv := &Server{DB: conn, SlackClient: fake}
	refreshed := recordRefresh(srv)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	if code := postJSON(t, ts.URL+"/api/thread/mark-read", `{"channel":"C1","thread_ts":"1.0","ts":"2.0"}`); code == http.StatusNoContent {
		t.Fatal("expected the failed mark to fail the request")
	}
	if got := refreshed(); len(got) != 0 {
		t.Fatalf("refreshed %v after a failed mark", got)
	}
}

// fakeThread is a thread of root 1.0 and replies 2.0, 3.0, read through lastRead.
func fakeThread(lastRead string) slack.Thread {
	return slack.Thread{
		Channel: "C1", ThreadTS: "1.0", LastRead: lastRead,
		Messages: []slack.Message{{TS: "1.0"}, {TS: "2.0"}, {TS: "3.0"}},
	}
}

// Slack has no "set last_read"; restore marks unread from the first message
// after the old cursor, which puts last_read just before it.
func TestSlackRestoreReadMarksUnreadFromTheFirstMessageAfterTheOldCursor(t *testing.T) {
	t.Parallel()
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := resources.Add(conn, wt, resources.Resource{Type: "slack", ID: "C1:1.0", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ lastRead, want string }{
		{"1.0", "2.0"},
		{"", "1.0"}, // never read: the whole thread goes back to unread
	} {
		fake := newFakeSlack()
		fake.thread = fakeThread("3.0")
		srv := &Server{DB: conn, SlackClient: fake}
		refreshed := recordRefresh(srv)
		ts := httptest.NewServer(srv.Handler())
		body := `{"channel":"C1","thread_ts":"1.0","last_read":"` + tc.lastRead + `","through":"3.0"}`
		if code := postJSON(t, ts.URL+"/api/thread/restore-read", body); code != http.StatusNoContent {
			t.Fatalf("last_read %q: status %d", tc.lastRead, code)
		}
		ts.Close()
		if fake.markUnreadTS != tc.want {
			t.Fatalf("last_read %q: marked unread from %q, want %q", tc.lastRead, fake.markUnreadTS, tc.want)
		}
		if got := refreshed(); len(got) != 1 {
			t.Fatalf("last_read %q: refreshed %v, want the tracked thread once", tc.lastRead, got)
		}
	}
}

func TestSlackRestoreReadRefusesWhenReadFurtherSince(t *testing.T) {
	t.Parallel()
	fake := newFakeSlack()
	fake.thread = fakeThread("4.0")
	srv := &Server{SlackClient: fake}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	body := `{"channel":"C1","thread_ts":"1.0","last_read":"1.0","through":"3.0"}`
	if code := postJSON(t, ts.URL+"/api/thread/restore-read", body); code != http.StatusConflict {
		t.Fatalf("status %d, want 409", code)
	}
	if fake.markUnreadTS != "" {
		t.Fatalf("marked unread from %q despite the conflict", fake.markUnreadTS)
	}
}

func TestSlackRestoreReadIsANoOpWhenNothingFollowsTheOldCursor(t *testing.T) {
	t.Parallel()
	fake := newFakeSlack()
	fake.thread = fakeThread("3.0")
	srv := &Server{SlackClient: fake}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	body := `{"channel":"C1","thread_ts":"1.0","last_read":"3.0","through":"3.0"}`
	if code := postJSON(t, ts.URL+"/api/thread/restore-read", body); code != http.StatusNoContent {
		t.Fatalf("status %d", code)
	}
	if fake.markUnreadTS != "" {
		t.Fatalf("marked unread from %q, want no write", fake.markUnreadTS)
	}
}
