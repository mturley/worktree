package webui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/mturley/watcher"
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
