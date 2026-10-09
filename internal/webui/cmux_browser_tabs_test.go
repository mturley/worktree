package webui

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/mturley/worktree/internal/cmux"
)

func getBrowserTabs(t *testing.T, s *Server) cmuxBrowserTabsResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handleCmuxBrowserTabs(rec, httptest.NewRequest(http.MethodGet, "/api/cmux/browser-tabs", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got cmuxBrowserTabsResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestCmuxBrowserTabsUnavailable(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "")
	got := getBrowserTabs(t, &Server{})
	if got.Available || got.Tabs == nil {
		t.Fatalf("got %+v, want available:false tabs:[]", got)
	}
}

func TestCmuxBrowserTabsReadFailureDegrades(t *testing.T) {
	s, f := newTabServer(t)
	f.browserTabsErr = errors.New("boom")
	got := getBrowserTabs(t, s)
	if got.Available || got.Tabs == nil {
		t.Fatalf("got %+v, want available:false tabs:[]", got)
	}
}

func TestCmuxBrowserTabsListsEveryWorkspace(t *testing.T) {
	s, f := newTabServer(t)
	f.browserTabs = []cmux.BrowserTab{
		{WorkspaceID: "A", WorkspaceRef: "workspace:1", WorkspaceTitle: "Alpha", WorkspaceSelected: true, Ref: "surface:2", URL: "https://x/a"},
		{WorkspaceID: "B", WorkspaceRef: "workspace:2", WorkspaceTitle: "Beta", Ref: "surface:7", URL: "https://x/b"},
	}
	got := getBrowserTabs(t, s)
	want := cmuxBrowserTabsResponse{Available: true, Tabs: []cmuxBrowserTabDTO{
		{WorkspaceID: "A", WorkspaceRef: "workspace:1", WorkspaceTitle: "Alpha", WorkspaceSelected: true, Surface: "surface:2", URL: "https://x/a"},
		{WorkspaceID: "B", WorkspaceRef: "workspace:2", WorkspaceTitle: "Beta", Surface: "surface:7", URL: "https://x/b"},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}
