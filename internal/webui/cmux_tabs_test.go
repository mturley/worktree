package webui

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/cmux"
)

// fakeTabOps records every cmux call as "name arg arg…" and serves trees from
// a map (a missing id is an error, like a workspace closed out of band).
type fakeTabOps struct {
	trees  map[string]*cmux.WorkspaceTree
	failOn string
	calls  []string
}

func posString(p cmux.TabPosition) string {
	switch {
	case p.Before != "":
		return "before " + p.Before
	case p.After != "":
		return "after " + p.After
	}
	return "end"
}

func (f *fakeTabOps) ops() *cmuxTabOps {
	rec := func(name string, args ...string) error {
		f.calls = append(f.calls, strings.TrimSpace(name+" "+strings.Join(args, " ")))
		if f.failOn == name {
			return errors.New(name + " failed")
		}
		return nil
	}
	return &cmuxTabOps{
		tree: func(id string) (*cmux.WorkspaceTree, error) {
			f.calls = append(f.calls, "tree "+id)
			if t, ok := f.trees[id]; ok {
				return t, nil
			}
			return nil, errors.New("workspace not found")
		},
		selectWorkspace: func(id string) error { return rec("select", id) },
		focusTab:        func(id, s string) error { return rec("focus", id, s) },
		activate:        func() error { return rec("activate") },
		closeTab:        func(id, s string) error { return rec("close", id, s) },
		reorderTab:      func(id, s string, p cmux.TabPosition) error { return rec("reorder", id, s, posString(p)) },
		moveTab:         func(id, s, pane string, p cmux.TabPosition) error { return rec("move", id, s, pane, posString(p)) },
		rename:          func(id, title string) error { return rec("rename", id, title) },
		clearName:       func(id string) error { return rec("clear-name", id) },
		setColor:        func(id, c string) error { return rec("set-color", id, c) },
		clearColor:      func(id string) error { return rec("clear-color", id) },
	}
}

func (f *fakeTabOps) called(prefix string) bool {
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}

func sampleTree() *cmux.WorkspaceTree {
	return &cmux.WorkspaceTree{
		Layout: cmux.LayoutNode{Direction: "horizontal", Split: 0.5, Children: []cmux.LayoutNode{{Pane: "pane:1"}, {Pane: "pane:2"}}},
		Panes: []cmux.TreePane{
			{Ref: "pane:1", Focused: true, Tabs: []cmux.TreeTab{
				{Ref: "surface:1", Type: "terminal", Title: "◐ agent", Selected: true},
				{Ref: "surface:2", Type: "browser", Title: "(5) inbox", URL: "https://example.com/inbox"},
			}},
			{Ref: "pane:2", Tabs: []cmux.TreeTab{
				{Ref: "surface:3", Type: "markdown", Title: "notes.md", Selected: true},
			}},
			{Ref: "pane:4", Tabs: []cmux.TreeTab{}},
		},
	}
}

func newTabServer(t *testing.T) (*Server, *fakeTabOps) {
	t.Helper()
	t.Setenv("CMUX_SOCKET_PATH", "/tmp/x")
	f := &fakeTabOps{trees: map[string]*cmux.WorkspaceTree{"W": sampleTree()}}
	return &Server{cmuxTabs: f.ops()}, f
}

// postCmux calls a handler with a JSON body and decodes a 200 reply.
func postCmux(t *testing.T, h http.HandlerFunc, body any) (int, cmuxActionResponse) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/api/cmux/x", bytes.NewReader(b)))
	var got cmuxActionResponse
	if rec.Code == http.StatusOK {
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
	}
	return rec.Code, got
}

func getTree(t *testing.T, s *Server, path string) (int, cmuxTreeResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handleCmuxTree(rec, httptest.NewRequest(http.MethodGet, "/api/cmux/tree?path="+path, nil))
	var got cmuxTreeResponse
	if rec.Code == http.StatusOK {
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
	}
	return rec.Code, got
}

func TestCmuxTreeRequiresPath(t *testing.T) {
	s, _ := newTabServer(t)
	if code, _ := getTree(t, s, ""); code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", code)
	}
}

func TestCmuxTreeUnavailable(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "")
	code, got := getTree(t, &Server{}, "/wt/a")
	if code != http.StatusOK || got.Available || got.Workspaces == nil {
		t.Fatalf("code=%d got=%+v, want 200 available:false workspaces:[]", code, got)
	}
}

func TestCmuxTreeListFailureDegrades(t *testing.T) {
	s, _ := newTabServer(t)
	s.cmuxList = func() ([]cmux.Workspace, error) { return nil, errors.New("boom") }
	code, got := getTree(t, s, "/wt/a")
	if code != http.StatusOK || got.Available {
		t.Fatalf("code=%d got=%+v, want 200 available:false", code, got)
	}
}

func TestCmuxTreeReturnsMatchedWorkspacesWithTheirTrees(t *testing.T) {
	s, f := newTabServer(t)
	dir := t.TempDir()
	other := t.TempDir()
	color := "#AD1457"
	s.cmuxList = func() ([]cmux.Workspace, error) {
		return []cmux.Workspace{
			{ID: "W", Ref: "workspace:1", Title: "Alpha", CustomColor: &color, CurrentDirectory: dir, Selected: true},
			// Closed out of band between list and tree: reported, not fatal.
			{ID: "GONE", Ref: "workspace:2", Title: "Beta", CurrentDirectory: dir},
			{ID: "ELSEWHERE", Ref: "workspace:3", Title: "Gamma", CurrentDirectory: other},
		}, nil
	}
	code, got := getTree(t, s, dir)
	if code != http.StatusOK || !got.Available {
		t.Fatalf("code=%d available=%v", code, got.Available)
	}
	if len(got.Workspaces) != 2 {
		t.Fatalf("got %d workspaces, want 2 (the third is another path): %+v", len(got.Workspaces), got.Workspaces)
	}
	a, b := got.Workspaces[0], got.Workspaces[1]
	if a.ID != "W" || a.Title != "Alpha" || a.Color != "#AD1457" || !a.Selected || a.Layout == nil || len(a.Panes) != 3 || a.Error != "" {
		t.Fatalf("first workspace = %+v", a)
	}
	if b.ID != "GONE" || b.Error == "" || b.Layout != nil || b.Panes != nil {
		t.Fatalf("second workspace = %+v, want an error and no layout", b)
	}
	if f.called("tree ELSEWHERE") {
		t.Fatal("read the tree of a workspace for another path")
	}
}

func TestCmuxRename(t *testing.T) {
	cases := []struct {
		name  string
		title string
		want  string
	}{
		{"renames", "  New name ", "rename W New name"},
		{"empty clears", "", "clear-name W"},
		// Whitespace is not a title: it means "give the name back to cmux".
		{"whitespace clears", "   ", "clear-name W"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, f := newTabServer(t)
			code, got := postCmux(t, s.handleCmuxRename, map[string]string{"id": "W", "title": c.title})
			if code != http.StatusOK || !got.OK {
				t.Fatalf("code=%d got=%+v", code, got)
			}
			if len(f.calls) != 1 || f.calls[0] != c.want {
				t.Fatalf("calls = %q, want [%q]", f.calls, c.want)
			}
		})
	}
}

func TestCmuxRenameMissingID(t *testing.T) {
	s, _ := newTabServer(t)
	if code, _ := postCmux(t, s.handleCmuxRename, map[string]string{"title": "x"}); code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", code)
	}
}

func TestCmuxColor(t *testing.T) {
	cases := []struct {
		color string
		code  int
		want  string
	}{
		{"#AD1457", http.StatusOK, "set-color W #AD1457"},
		{"teal", http.StatusOK, "set-color W teal"},
		{"", http.StatusOK, "clear-color W"},
		{"#12345", http.StatusBadRequest, ""},
		{"red; rm -rf", http.StatusBadRequest, ""},
	}
	for _, c := range cases {
		t.Run(c.color, func(t *testing.T) {
			s, f := newTabServer(t)
			code, _ := postCmux(t, s.handleCmuxColor, map[string]string{"id": "W", "color": c.color})
			if code != c.code {
				t.Fatalf("status = %d, want %d", code, c.code)
			}
			if c.want == "" && len(f.calls) != 0 {
				t.Fatalf("called cmux on a rejected colour: %q", f.calls)
			}
			if c.want != "" && (len(f.calls) != 1 || f.calls[0] != c.want) {
				t.Fatalf("calls = %q, want [%q]", f.calls, c.want)
			}
		})
	}
}

func TestCmuxFocusTabSelectsFocusesActivates(t *testing.T) {
	s, f := newTabServer(t)
	code, got := postCmux(t, s.handleCmuxFocusTab, map[string]string{"id": "W", "surface": "surface:2"})
	if code != http.StatusOK || !got.OK {
		t.Fatalf("code=%d got=%+v", code, got)
	}
	want := []string{"select W", "focus W surface:2", "activate"}
	if strings.Join(f.calls, "|") != strings.Join(want, "|") {
		t.Fatalf("calls = %q, want %q", f.calls, want)
	}
}

func TestCmuxFocusTabActivateFailureIsNotAFailure(t *testing.T) {
	s, f := newTabServer(t)
	f.failOn = "activate"
	if _, got := postCmux(t, s.handleCmuxFocusTab, map[string]string{"id": "W", "surface": "surface:2"}); !got.OK {
		t.Fatalf("got %+v, want ok despite activate failing", got)
	}
}

func TestCmuxFocusTabReportsCmuxFailure(t *testing.T) {
	s, f := newTabServer(t)
	f.failOn = "focus"
	code, got := postCmux(t, s.handleCmuxFocusTab, map[string]string{"id": "W", "surface": "surface:2"})
	if code != http.StatusOK || got.OK || got.Error == "" {
		t.Fatalf("code=%d got=%+v, want 200 ok:false with error", code, got)
	}
}

func TestCmuxFocusTabValidatesSurface(t *testing.T) {
	s, f := newTabServer(t)
	for _, bad := range []string{"", "surface:", "surface:1 --workspace X", "pane:1", "--help"} {
		if code, _ := postCmux(t, s.handleCmuxFocusTab, map[string]string{"id": "W", "surface": bad}); code != http.StatusBadRequest {
			t.Errorf("surface %q: status = %d, want 400", bad, code)
		}
	}
	if len(f.calls) != 0 {
		t.Fatalf("called cmux on invalid input: %q", f.calls)
	}
}

func TestCmuxWritesWhenUnavailable(t *testing.T) {
	s, f := newTabServer(t)
	t.Setenv("CMUX_SOCKET_PATH", "")
	code, got := postCmux(t, s.handleCmuxRename, map[string]string{"id": "W", "title": "x"})
	if code != http.StatusOK || got.OK || len(f.calls) != 0 {
		t.Fatalf("code=%d got=%+v calls=%q, want 200 ok:false and no calls", code, got, f.calls)
	}
}

func TestNormalizeTitle(t *testing.T) {
	cases := map[string]string{
		"◐ agent":            "agent",
		"◑ agent":            "agent",
		"🚧 wip":              "wip",
		"⚠️ build":           "build", // symbol + variation selector
		"(5) worktree":       "(5) worktree",
		"[RHAISTRAT-1] page": "[RHAISTRAT-1] page",
		"…/path":             "…/path",
		"◐":                  "",
		"plain":              "plain",
		"pi - x:🚧":           "pi - x:",
		"pi - x:✅":           "pi - x:",
		"title (5)":          "title (5)",
	}
	for in, want := range cases {
		if got := normalizeTitle(in); got != want {
			t.Errorf("normalizeTitle(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCmuxCloseTabGuard(t *testing.T) {
	cases := []struct {
		name      string
		surface   string
		typ       string
		title     string
		wantClose bool
	}{
		{"exact match", "surface:2", "browser", "(5) inbox", true},
		{"agent glyph changed", "surface:1", "terminal", "◑ agent", true},
		{"ref gone", "surface:9", "browser", "(5) inbox", false},
		{"type changed", "surface:1", "browser", "◐ agent", false},
		{"retitled", "surface:3", "markdown", "other.md", false},
		{"count changed", "surface:2", "browser", "(6) inbox", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, f := newTabServer(t)
			code, got := postCmux(t, s.handleCmuxCloseTab, map[string]string{"id": "W", "surface": c.surface, "type": c.typ, "title": c.title})
			if code != http.StatusOK {
				t.Fatalf("status = %d", code)
			}
			if c.wantClose {
				if !got.OK || !f.called("close W "+c.surface) {
					t.Fatalf("got=%+v calls=%q, want closed", got, f.calls)
				}
				return
			}
			if got.OK || !got.Stale || got.Error != staleTabMessage {
				t.Fatalf("got=%+v, want stale", got)
			}
			if f.called("close") {
				t.Fatalf("closed a tab that failed the guard: %q", f.calls)
			}
		})
	}
}

func TestCmuxCloseTabTreeFailureIsNotStale(t *testing.T) {
	s, f := newTabServer(t)
	code, got := postCmux(t, s.handleCmuxCloseTab, map[string]string{"id": "GONE", "surface": "surface:1", "type": "terminal", "title": "x"})
	if code != http.StatusOK || got.OK || got.Stale || got.Error == "" || f.called("close") {
		t.Fatalf("code=%d got=%+v calls=%q", code, got, f.calls)
	}
}

type anchorBody struct {
	Surface  string `json:"surface"`
	Type     string `json:"type"`
	Title    string `json:"title"`
	Position string `json:"position"`
}

type moveBody struct {
	ID      string      `json:"id"`
	Surface string      `json:"surface"`
	Type    string      `json:"type"`
	Title   string      `json:"title"`
	Pane    string      `json:"pane"`
	Anchor  *anchorBody `json:"anchor,omitempty"`
}

// dragged is surface:2 ("(5) inbox", pane:1) unless a case overrides it.
func moveOf(pane string, anchor *anchorBody) moveBody {
	return moveBody{ID: "W", Surface: "surface:2", Type: "browser", Title: "(5) inbox", Pane: pane, Anchor: anchor}
}

func TestCmuxMoveTab(t *testing.T) {
	agent := func(pos string) *anchorBody {
		return &anchorBody{Surface: "surface:1", Type: "terminal", Title: "◑ agent", Position: pos}
	}
	notes := func(pos string) *anchorBody {
		return &anchorBody{Surface: "surface:3", Type: "markdown", Title: "notes.md", Position: pos}
	}
	cases := []struct {
		name string
		body moveBody
		want string // "" means stale
	}{
		{"same pane before", moveOf("pane:1", agent("before")), "reorder W surface:2 before surface:1"},
		{"same pane to end", moveOf("pane:1", nil), "reorder W surface:2 end"},
		{"other pane after", moveOf("pane:2", notes("after")), "move W surface:2 pane:2 after surface:3"},
		{"other pane to end", moveOf("pane:2", nil), "move W surface:2 pane:2 end"},
		{"into an empty pane", moveOf("pane:4", nil), "move W surface:2 pane:4 end"},
		{"dragged tab changed", moveBody{ID: "W", Surface: "surface:2", Type: "browser", Title: "(6) inbox", Pane: "pane:2"}, ""},
		{"anchor changed", moveOf("pane:2", &anchorBody{Surface: "surface:3", Type: "markdown", Title: "renamed.md", Position: "before"}), ""},
		{"anchor not in the named pane", moveOf("pane:2", agent("before")), ""},
		{"unknown pane", moveOf("pane:9", nil), ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, f := newTabServer(t)
			code, got := postCmux(t, s.handleCmuxMoveTab, c.body)
			if code != http.StatusOK {
				t.Fatalf("status = %d", code)
			}
			if c.want == "" {
				if got.OK || !got.Stale || f.called("reorder") || f.called("move") {
					t.Fatalf("got=%+v calls=%q, want stale and nothing moved", got, f.calls)
				}
				return
			}
			if !got.OK || !f.called(c.want) {
				t.Fatalf("got=%+v calls=%q, want %q", got, f.calls, c.want)
			}
		})
	}
}

func TestCmuxMoveTabValidation(t *testing.T) {
	cases := map[string]moveBody{
		"bad pane":           moveOf("pane", nil),
		"bad surface":        {ID: "W", Surface: "surface:x", Pane: "pane:1"},
		"missing id":         {Surface: "surface:2", Pane: "pane:1"},
		"own anchor":         moveOf("pane:1", &anchorBody{Surface: "surface:2", Type: "browser", Title: "(5) inbox", Position: "before"}),
		"bad position":       moveOf("pane:1", &anchorBody{Surface: "surface:1", Type: "terminal", Title: "◐ agent", Position: "inside"}),
		"bad anchor surface": moveOf("pane:1", &anchorBody{Surface: "1", Position: "before"}),
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			s, f := newTabServer(t)
			if code, _ := postCmux(t, s.handleCmuxMoveTab, body); code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", code)
			}
			if len(f.calls) != 0 {
				t.Fatalf("called cmux on invalid input: %q", f.calls)
			}
		})
	}
}
