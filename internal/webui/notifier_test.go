package webui

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/notifyprefs"
)

type fakeTransport struct{ got []notifyBatch }

func (f *fakeTransport) Deliver(b notifyBatch, _ deliverOpts) { f.got = append(f.got, b) }

func TestNotifyModeFollowsCmuxAvailability(t *testing.T) {
	on := &Server{cmuxAvailable: func() bool { return true }}
	off := &Server{cmuxAvailable: func() bool { return false }}
	if on.notifyMode() != "cmux" || off.notifyMode() != "browser" {
		t.Fatalf("modes = %q, %q", on.notifyMode(), off.notifyMode())
	}
}

func TestCmuxTransportTargetsWorkspace(t *testing.T) {
	wt := t.TempDir()
	var calls []cmux.NotifyOptions
	s := &Server{
		cmuxAvailable: func() bool { return true },
		cmuxList: func() ([]cmux.Workspace, error) {
			return []cmux.Workspace{{ID: "WS-UUID", Ref: "workspace:3", CurrentDirectory: wt}}, nil
		},
		cmuxNotify: func(o cmux.NotifyOptions) error { calls = append(calls, o); return nil },
	}
	s.deliver(notifyBatch{WorktreePath: wt, Title: "T", Subtitle: "S", Body: "B"}, deliverOpts{})
	if len(calls) != 1 || calls[0] != (cmux.NotifyOptions{Title: "T", Subtitle: "S", Body: "B", Workspace: "WS-UUID"}) {
		t.Fatalf("calls = %+v", calls)
	}
}

func TestCmuxTransportWithoutWorkspaceIsUntargeted(t *testing.T) {
	var calls []cmux.NotifyOptions
	s := &Server{
		cmuxAvailable: func() bool { return true },
		cmuxList:      func() ([]cmux.Workspace, error) { return nil, nil },
		cmuxNotify:    func(o cmux.NotifyOptions) error { calls = append(calls, o); return errors.New("boom") },
	}
	s.deliver(notifyBatch{WorktreePath: t.TempDir(), Title: "T"}, deliverOpts{})
	if len(calls) != 1 || calls[0].Workspace != "" {
		t.Fatalf("calls = %+v (a failure must be logged, not retried)", calls)
	}
}

func TestNotifyPassAdvancesEvenWhenDeliveryFails(t *testing.T) {
	conn := unreadTestDB(t)
	a, _ := twoWorktrees(t, conn)
	notifyprefs.SetAll(conn, a, true)
	ft := &fakeTransport{}
	s := &Server{DB: conn, transport: ft}
	s.notifyOnce.Do(func() {}) // pin the fake transport
	c, _ := initNotifyCursor(conn)
	insertTypedEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "pr_comment", "hello", "pr", "o/r#7")
	s.notifyPass(&c)
	s.notifyPass(&c)
	if len(ft.got) != 1 || ft.got[0].Body != "hello" {
		t.Fatalf("delivered %+v, want exactly one batch", ft.got)
	}
}

func TestSessionReportsNotifyMode(t *testing.T) {
	srv, store, _ := securedServer(t)
	srv.cmuxAvailable = func() bool { return true }
	token, _, err := store.Create("test")
	if err != nil {
		t.Fatal(err)
	}
	rec := serve(srv.Handler(), apiRequest("GET", "/api/session", "", &http.Cookie{Name: sessionCookieName, Value: token}))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"notify_mode":"cmux"`) {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
}
