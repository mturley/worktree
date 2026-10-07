package webui

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/testgit"
)

func TestCmuxFocusPublishesMatchingWorktree(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := registerWorktreeForTest(t, conn, wt); err != nil {
		t.Fatal(err)
	}
	s := &Server{DB: conn, cmuxList: func() ([]cmux.Workspace, error) {
		return []cmux.Workspace{
			{ID: "W1", CurrentDirectory: wt},
			{ID: "W2", CurrentDirectory: t.TempDir()},
		}, nil
	}}
	focus, done := s.focusHub().subscribe()
	defer done()

	next := func() cmuxFocusMsg {
		t.Helper()
		select {
		case m := <-focus:
			return m
		case <-time.After(time.Second):
			t.Fatal("no cmux_focus message")
			return cmuxFocusMsg{}
		}
	}

	s.onCmuxFocus("W1")
	if m := next(); m.WorkspaceID != "W1" || m.Path != wt {
		t.Errorf("W1: got %+v, want path %q", m, wt)
	}

	// Refocusing the same workspace (cmux coming forward) is not a change.
	s.onCmuxFocus("W1")
	// A workspace on no registered worktree still reports, with no path, so
	// a following tab knows focus left the worktree it is showing.
	s.onCmuxFocus("W2")
	if m := next(); m.WorkspaceID != "W2" || m.Path != "" {
		t.Errorf("W2: got %+v, want empty path", m)
	}
	// Unknown to the listing: no path rather than a guess.
	s.onCmuxFocus("W9")
	if m := next(); m.WorkspaceID != "W9" || m.Path != "" {
		t.Errorf("W9: got %+v, want empty path", m)
	}
	select {
	case m := <-focus:
		t.Errorf("unexpected extra message %+v", m)
	default:
	}
}

func TestCmuxFocusWatchSkippedOutsideCmux(t *testing.T) {
	called := make(chan struct{}, 1)
	s := &Server{
		cmuxAvailable: func() bool { return false },
		cmuxWatchFocus: func(ctx context.Context, _ func(string)) error {
			called <- struct{}{}
			return nil
		},
	}
	stop := s.StartCmuxFocusWatch()
	defer stop()
	select {
	case <-called:
		t.Error("watched cmux focus with cmux unavailable")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestCmuxFocusWatchFeedsHub(t *testing.T) {
	s := &Server{
		cmuxAvailable: func() bool { return true },
		cmuxList:      func() ([]cmux.Workspace, error) { return nil, nil },
		cmuxWatchFocus: func(ctx context.Context, onFocus func(string)) error {
			onFocus("W1")
			<-ctx.Done()
			return ctx.Err()
		},
	}
	focus, done := s.focusHub().subscribe()
	defer done()
	stop := s.StartCmuxFocusWatch()
	defer stop()
	select {
	case m := <-focus:
		if m.WorkspaceID != "W1" {
			t.Errorf("got %+v", m)
		}
	case <-time.After(time.Second):
		t.Fatal("no message from the watch")
	}
}

func TestCmuxFocusedReportsSelectedWorkspace(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := registerWorktreeForTest(t, conn, wt); err != nil {
		t.Fatal(err)
	}
	listing := []cmux.Workspace{
		{ID: "W1", CurrentDirectory: t.TempDir()},
		{ID: "W2", CurrentDirectory: wt, Selected: true},
	}
	s := &Server{DB: conn,
		cmuxAvailable: func() bool { return true },
		cmuxList:      func() ([]cmux.Workspace, error) { return listing, nil }}

	get := func() cmuxFocusMsg {
		t.Helper()
		rec := httptest.NewRecorder()
		s.handleCmuxFocused(rec, httptest.NewRequest("GET", "/api/cmux/focused", nil))
		var m cmuxFocusMsg
		if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
			t.Fatal(err)
		}
		return m
	}

	if m := get(); m.WorkspaceID != "W2" || m.Path != wt {
		t.Errorf("got %+v, want W2 at %q", m, wt)
	}

	// Selected workspace on no registered worktree: the ID, no path.
	listing = []cmux.Workspace{{ID: "W1", CurrentDirectory: t.TempDir(), Selected: true}}
	if m := get(); m.WorkspaceID != "W1" || m.Path != "" {
		t.Errorf("got %+v, want W1 with no path", m)
	}

	s.cmuxAvailable = func() bool { return false }
	if m := get(); m != (cmuxFocusMsg{}) {
		t.Errorf("outside cmux: got %+v, want empty", m)
	}
}
