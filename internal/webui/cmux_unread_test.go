package webui

import (
	"errors"
	"sort"
	"testing"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
)

// unreadSyncFixture builds two registered worktrees, one with an unread PR
// and one whose PR is fully read, plus a server whose cmux seams record
// renames.
func unreadSyncFixture(t *testing.T) (s *Server, f *fakeTabOps, unreadWT, readWT string) {
	t.Helper()
	t.Setenv("CMUX_SOCKET_PATH", "/tmp/x")
	conn := unreadTestDB(t)
	unreadWT = testgit.Worktree(t)
	readWT = testgit.Worktree(t)
	for _, wt := range []string{unreadWT, readWT} {
		if err := registerWorktreeForTest(t, conn, wt); err != nil {
			t.Fatal(err)
		}
	}
	if err := resources.Add(conn, unreadWT, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u", Related: true}); err != nil {
		t.Fatal(err)
	}
	if err := resources.Add(conn, readWT, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	// resources.Add seeds each cursor at the newest event, so only an event
	// from after it is unread.
	insertUnreadEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	insertUnreadEvent(t, conn, "e2", "2000-01-01T00:00:00Z", "github", "pr", "o/r#2")

	f = &fakeTabOps{}
	s = &Server{DB: conn, cmuxTabs: f.ops(),
		cmuxList: func() ([]cmux.Workspace, error) { return f.workspaces, f.listErr }}
	return s, f, unreadWT, readWT
}

func TestCmuxUnreadSync(t *testing.T) {
	s, f, unreadWT, readWT := unreadSyncFixture(t)
	f.workspaces = []cmux.Workspace{
		// Unread worktree: two workspaces, both get the mailbox; a third
		// already has it and is left alone.
		{ID: "W1", CustomTitle: "Unread one", CurrentDirectory: unreadWT},
		{ID: "W2", CustomTitle: "Unread two", CurrentDirectory: unreadWT},
		{ID: "W3", CustomTitle: "📬 Already", CurrentDirectory: unreadWT},
		// Auto-titled: never touched, unread or not.
		{ID: "W4", Title: "◐ auto", CurrentDirectory: unreadWT},
		// Read worktree: the mailbox comes off; one without it is left alone.
		{ID: "W5", CustomTitle: "📬 Read now", CurrentDirectory: readWT},
		{ID: "W6", CustomTitle: "Plain", CurrentDirectory: readWT},
		// Not a registered worktree: whatever its title, not ours to change.
		{ID: "W7", CustomTitle: "📬 Elsewhere", CurrentDirectory: t.TempDir()},
	}

	s.cmuxUnreadPass()

	got := append([]string(nil), f.calls...)
	sort.Strings(got)
	want := []string{
		"rename W1 📬 Unread one",
		"rename W2 📬 Unread two",
		"rename W5 Read now",
	}
	if len(got) != len(want) {
		t.Fatalf("calls = %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("calls = %q, want %q", got, want)
		}
	}
}

func TestCmuxUnreadSyncIdleWhenSettled(t *testing.T) {
	s, f, unreadWT, readWT := unreadSyncFixture(t)
	f.workspaces = []cmux.Workspace{
		{ID: "W1", CustomTitle: "📬 Unread", CurrentDirectory: unreadWT},
		{ID: "W2", CustomTitle: "Read", CurrentDirectory: readWT},
	}
	s.cmuxUnreadPass()
	if len(f.calls) != 0 {
		t.Fatalf("calls = %q, want none", f.calls)
	}
}

func TestCmuxUnreadSyncSkipsWithoutCmux(t *testing.T) {
	s, f, unreadWT, _ := unreadSyncFixture(t)
	t.Setenv("CMUX_SOCKET_PATH", "")
	f.workspaces = []cmux.Workspace{{ID: "W1", CustomTitle: "Unread", CurrentDirectory: unreadWT}}
	s.cmuxUnreadPass()
	if len(f.calls) != 0 {
		t.Fatalf("calls = %q, want none", f.calls)
	}
}

func TestCmuxUnreadSyncSurvivesListFailure(t *testing.T) {
	s, f, _, _ := unreadSyncFixture(t)
	f.listErr = errors.New("boom")
	s.cmuxUnreadPass()
	if len(f.calls) != 0 {
		t.Fatalf("calls = %q, want none", f.calls)
	}
}
