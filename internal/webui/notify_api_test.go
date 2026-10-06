package webui

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"

	"github.com/mturley/worktree/internal/notifyprefs"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
	"github.com/mturley/worktree/internal/uisession"
)

func notifyAPIServer(t *testing.T) (*Server, string, *fakeTransport) {
	t.Helper()
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	registry.Register(conn, registry.Entry{Path: wt, Repo: "r", RepoRoot: "/r", Branch: "b", CreatedAt: "now"})
	resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#3", URL: "u"})
	resources.Add(conn, wt, resources.Resource{Type: "link", ID: "https://example.com", URL: "https://example.com"})
	ft := &fakeTransport{}
	s := &Server{DB: conn, transport: ft}
	s.notifyOnce.Do(func() {})
	return s, wt, ft
}

func postNotify(s *Server, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/notify", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(context.WithValue(req.Context(), sessionContextKey{}, uisession.Session{Handle: "s1"}))
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func TestNotifyAPIResourceToggleSendsTest(t *testing.T) {
	s, wt, ft := notifyAPIServer(t)
	if rec := postNotify(s, map[string]any{"path": wt, "type": "pr", "id": "o/r#3", "on": true}); rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	p, _ := notifyprefs.Get(s.DB, wt)
	if !p.Resources[notifyprefs.Key{Type: "pr", ID: "o/r#3"}] {
		t.Fatal("toggle not stored")
	}
	if len(ft.got) != 1 || ft.got[0].Title != "Notifications on" ||
		ft.got[0].Body != "You'll be notified about new events for PR #3" || ft.got[0].Subtitle != filepath.Base(wt) {
		t.Fatalf("test notification = %+v", ft.got)
	}

	postNotify(s, map[string]any{"path": wt, "type": "pr", "id": "o/r#3", "on": false})
	if len(ft.got) != 1 {
		t.Fatal("turning off must not send a test notification")
	}
}

func TestNotifyAPIWorktreeWide(t *testing.T) {
	s, wt, ft := notifyAPIServer(t)
	if rec := postNotify(s, map[string]any{"path": wt, "on": true}); rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if p, _ := notifyprefs.Get(s.DB, wt); !p.All {
		t.Fatal("worktree-wide toggle not stored")
	}
	want := "You'll be notified about new events for all resources in " + filepath.Base(wt)
	if len(ft.got) != 1 || ft.got[0].Body != want || ft.got[0].Tag != notifyTag(wt, "", "") {
		t.Fatalf("got %+v", ft.got)
	}
}

func TestNotifyAPIRejects(t *testing.T) {
	s, wt, _ := notifyAPIServer(t)
	cases := []struct {
		body map[string]any
		code int
	}{
		{map[string]any{"on": true}, http.StatusBadRequest},
		{map[string]any{"path": wt, "type": "pr", "on": true}, http.StatusBadRequest},
		{map[string]any{"path": wt, "type": "link", "id": "https://example.com", "on": true}, http.StatusBadRequest},
		{map[string]any{"path": t.TempDir(), "on": true}, http.StatusNotFound},
		{map[string]any{"path": wt, "type": "pr", "id": "o/r#404", "on": true}, http.StatusNotFound},
	}
	for _, c := range cases {
		if rec := postNotify(s, c.body); rec.Code != c.code {
			t.Errorf("%v: status %d, want %d", c.body, rec.Code, c.code)
		}
	}
}

func TestDTOsCarryNotifyFlags(t *testing.T) {
	s, wt, _ := notifyAPIServer(t)
	notifyprefs.SetResource(s.DB, wt, "pr", "o/r#3", true)
	resources.SetPrimary(s.DB, wt, "pr", "o/r#3", true)

	rec := httptest.NewRecorder()
	s.handleWorktreeResources(rec, httptest.NewRequest("GET", "/api/worktree-resources?path="+url.QueryEscape(wt), nil))
	var rs []resourceDTO
	json.NewDecoder(rec.Body).Decode(&rs)
	found := false
	for _, r := range rs {
		if r.ID == "o/r#3" {
			found = r.Notify
		}
	}
	if !found {
		t.Fatalf("resource DTO lacks notify: %+v", rs)
	}

	notifyprefs.SetAll(s.DB, wt, true)
	rec = httptest.NewRecorder()
	s.handleWorktrees(rec, httptest.NewRequest("GET", "/api/worktrees", nil))
	var ws []worktreeSummary
	json.NewDecoder(rec.Body).Decode(&ws)
	if len(ws) != 1 || !ws[0].NotifyAll {
		t.Fatalf("worktree summary lacks notify_all: %+v", ws)
	}
	// The link is focus too (first of its type), so look the PR up by id.
	prNotify := false
	for _, r := range ws[0].FocusResources {
		if r.ID == "o/r#3" {
			prNotify = r.Notify
		}
	}
	if !prNotify {
		t.Fatalf("focus PR lacks notify: %+v", ws[0].FocusResources)
	}
}
