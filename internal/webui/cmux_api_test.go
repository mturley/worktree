package webui

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/cmux"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
)

func TestCmuxUnavailableReturnsAvailableFalse(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "")
	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleCmux(rec, httptest.NewRequest(http.MethodGet, "/api/cmux", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (a cmux failure must never 5xx)", rec.Code)
	}
	var got struct {
		Available bool `json:"available"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Available {
		t.Fatal("available = true with no cmux socket")
	}
}

func TestCmuxAvailableBuildsMatchesKeyedByOriginalPath(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "/tmp/x")

	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	matchedPath := t.TempDir()
	unmatchedPath := t.TempDir()
	for _, p := range []string{matchedPath, unmatchedPath} {
		if err := registry.Register(conn, registry.Entry{Path: p, Repo: "r", RepoRoot: p, Branch: "b", CreatedAt: "now"}); err != nil {
			t.Fatal(err)
		}
	}

	hex := "#AD1457"
	s := &Server{
		DB: conn,
		cmuxList: func() ([]cmux.Workspace, error) {
			return []cmux.Workspace{
				{Ref: "ws-a", Title: "Alpha", CurrentDirectory: matchedPath, Selected: true},
				{Ref: "ws-b", CustomTitle: "Beta", CustomColor: &hex, CurrentDirectory: matchedPath},
			}, nil
		},
	}

	rec := httptest.NewRecorder()
	s.handleCmux(rec, httptest.NewRequest(http.MethodGet, "/api/cmux", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got cmuxResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if !got.Available {
		t.Fatal("available = false, want true")
	}
	if _, ok := got.Matches[unmatchedPath]; ok {
		t.Fatalf("unmatched path %q present in matches, want absent", unmatchedPath)
	}
	hits, ok := got.Matches[matchedPath]
	if !ok {
		t.Fatalf("matched path %q absent from matches", matchedPath)
	}
	if len(hits) != 2 {
		t.Fatalf("len(hits) = %d, want 2", len(hits))
	}
	byRef := map[string]cmuxWorkspaceDTO{}
	for _, h := range hits {
		byRef[h.Ref] = h
	}
	a, ok := byRef["ws-a"]
	if !ok {
		t.Fatal("ws-a missing from hits")
	}
	if a.Title != "Alpha" {
		t.Fatalf("a.Title = %q, want Alpha", a.Title)
	}
	if a.Color != "" {
		t.Fatalf("a.Color = %q, want empty for nil CustomColor", a.Color)
	}
	if !a.Selected {
		t.Fatal("a.Selected = false, want true")
	}
	b, ok := byRef["ws-b"]
	if !ok {
		t.Fatal("ws-b missing from hits")
	}
	if b.Title != "Beta" {
		t.Fatalf("b.Title = %q, want Beta (CustomTitle fallback)", b.Title)
	}
	if b.Color != hex {
		t.Fatalf("b.Color = %q, want %q", b.Color, hex)
	}
}

func TestCmuxAvailableWithNilDBDoesNotPanic(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "/tmp/x")

	s := &Server{
		cmuxList: func() ([]cmux.Workspace, error) {
			return []cmux.Workspace{{Ref: "ws-a", Title: "Alpha", CurrentDirectory: "/some/dir"}}, nil
		},
	}

	rec := httptest.NewRecorder()
	s.handleCmux(rec, httptest.NewRequest(http.MethodGet, "/api/cmux", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (nil DB must not panic or 5xx)", rec.Code)
	}
	var got cmuxResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if !got.Available {
		t.Fatal("available = false, want true")
	}
	if len(got.Matches) != 0 {
		t.Fatalf("matches = %v, want empty with no registry paths", got.Matches)
	}
}

func TestCmuxListErrorReturnsAvailableFalse(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "/tmp/x")

	s := &Server{
		cmuxList: func() ([]cmux.Workspace, error) {
			return nil, errors.New("cmux workspace list: exit status 1")
		},
	}

	rec := httptest.NewRecorder()
	s.handleCmux(rec, httptest.NewRequest(http.MethodGet, "/api/cmux", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (a cmux failure must never 5xx)", rec.Code)
	}
	var got cmuxResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Available {
		t.Fatal("available = true despite cmuxList error")
	}
}

func TestCmuxGroupsReturnsColorsAndGroups(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "/tmp/x")

	s := &Server{
		cmuxListGroups: func() ([]cmux.WorkspaceGroup, error) {
			return []cmux.WorkspaceGroup{{Ref: "grp-1", Name: "Group One"}}, nil
		},
	}

	rec := httptest.NewRecorder()
	s.handleCmuxGroups(rec, httptest.NewRequest(http.MethodGet, "/api/cmux-groups", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got cmuxGroupsResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	foundBlue := false
	for _, c := range got.Colors {
		if c.Name == "Blue" && c.Hex == "#2980B9" {
			foundBlue = true
		}
	}
	if !foundBlue {
		t.Fatalf("colors = %v, want Blue/#2980B9 from cmux.NamedColors", got.Colors)
	}
	if len(got.Groups) != 1 || got.Groups[0].Ref != "grp-1" || got.Groups[0].Name != "Group One" {
		t.Fatalf("groups = %v, want stubbed [grp-1/Group One]", got.Groups)
	}
}

func TestCmuxSelectRequiresRef(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/cmux/select", strings.NewReader(`{}`))
	s.handleCmuxSelect(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a missing ref", rec.Code)
	}
}

func TestCmuxCreateRequiresPath(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/cmux/create", strings.NewReader(`{"name":"x"}`))
	s.handleCmuxCreate(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a missing path", rec.Code)
	}
}

func TestCmuxCreateUnavailableIsNotAnError(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "")
	s := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/cmux/create",
		strings.NewReader(`{"path":"/wt/a","name":"x"}`))
	s.handleCmuxCreate(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (cmux failures never 5xx)", rec.Code)
	}
	var got cmuxActionResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.OK {
		t.Fatal("ok = true with cmux unavailable")
	}
}

func TestWorktreeDetailURLUsesPathSegmentAndEscapesSpecialChars(t *testing.T) {
	got := worktreeDetailURL(8475, "/tmp/my worktree")
	want := "http://127.0.0.1:8475/worktree/%2Ftmp%2Fmy%20worktree?home=%2Ftmp%2Fmy+worktree"
	if got != want {
		t.Fatalf("worktreeDetailURL = %q, want %q", got, want)
	}
	if strings.Contains(got, "?path=") {
		t.Fatalf("worktreeDetailURL = %q, must not use ?path= query form", got)
	}
}

// TestWorktreeDetailURLCarriesHomeMarker states the intent the escaping test
// above only incidentally covers: a workspace's UI pane is opened FOR one
// worktree, and the marker is how the tab knows which.
func TestWorktreeDetailURLCarriesHomeMarker(t *testing.T) {
	got := worktreeDetailURL(8475, "/wt/foo")
	// The PATH, not a flag: once the UI navigates to the listing there is no
	// pathname left for a flag to refer to.
	if !strings.HasSuffix(got, "?home=%2Fwt%2Ffoo") {
		t.Fatalf("worktreeDetailURL = %q, want the home path in the query", got)
	}
}
