package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
)

// AppUnread is unreadBadge's fold over /api/worktrees, without the HTTP: the
// menu bar icon and the tab's favicon must never disagree.
func TestAppUnreadMatchesTheWorktreeList(t *testing.T) {
	t.Parallel()
	conn := unreadTestDB(t)
	busy := testgit.Worktree(t)
	quiet := testgit.Worktree(t)
	for _, wt := range []string{busy, quiet} {
		if err := registerWorktreeForTest(t, conn, wt); err != nil {
			t.Fatal(err)
		}
	}
	// busy: a focus PR with 2 unread and a related Jira issue with 1.
	if err := resources.Add(conn, busy, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	if err := resources.Add(conn, busy, resources.Resource{Type: "jira", ID: "J-1", URL: "u", Related: true}); err != nil {
		t.Fatal(err)
	}
	insertUnreadEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	insertUnreadEvent(t, conn, "e2", "2099-01-02T00:00:00Z", "github", "pr", "o/r#1")
	insertUnreadEvent(t, conn, "e3", "2099-01-03T00:00:00Z", "jira", "jira", "J-1")
	// quiet: everything predates its cursor.
	if err := resources.Add(conn, quiet, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	insertUnreadEvent(t, conn, "e4", "2000-01-01T00:00:00Z", "github", "pr", "o/r#2")

	srv := &Server{DB: conn}
	got, err := srv.AppUnread()
	if err != nil {
		t.Fatal(err)
	}

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktrees")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var list []worktreeSummary
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	var want UnreadSummary
	for _, w := range list {
		if w.HasUnread {
			want.Unread = true
			want.Count += w.UnreadCount
		}
	}

	if got != want {
		t.Fatalf("AppUnread = %+v, the worktree list folds to %+v", got, want)
	}
	if got != (UnreadSummary{Unread: true, Count: 3}) {
		t.Fatalf("AppUnread = %+v, want unread with 3 (busy's 2 + 1; quiet adds none)", got)
	}
}

func TestAppUnreadAllRead(t *testing.T) {
	t.Parallel()
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := registerWorktreeForTest(t, conn, wt); err != nil {
		t.Fatal(err)
	}
	if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#3", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	insertUnreadEvent(t, conn, "e1", "2000-01-01T00:00:00Z", "github", "pr", "o/r#3")
	got, err := (&Server{DB: conn}).AppUnread()
	if err != nil {
		t.Fatal(err)
	}
	if got != (UnreadSummary{}) {
		t.Fatalf("AppUnread = %+v, want nothing unread", got)
	}
}
