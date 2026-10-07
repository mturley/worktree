package webui

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/cmux"
)

// cmux workspace ids are UUIDs; these two stand in for "the workspace" and
// "a workspace closed out of band" across the tests below.
const (
	wsID   = "AAAAAAAA-0000-4000-8000-000000000001"
	goneID = "AAAAAAAA-0000-4000-8000-000000000002"
)

// fakeTabOps records every cmux call as "name arg arg…" and serves trees from
// a map (a missing id is an error, like a workspace closed out of band).
// treeSeq, when set for an id, serves a SEQUENCE of trees across successive
// `tree` calls for that id (the last one repeats once exhausted) — used to
// simulate a stale read lagging a close/move before cmux catches up.
type fakeTabOps struct {
	trees   map[string]*cmux.WorkspaceTree
	treeSeq map[string][]*cmux.WorkspaceTree
	treePos map[string]int
	failOn  string
	calls   []string

	// notifications and notificationsErr back the notifications seam; nil
	// notificationsErr with a nil notifications func means "no notifications".
	notifications    []cmux.Notification
	notificationsErr error
	notificationsN   int // number of times notifications() was called
}

func posString(p cmux.TabPosition) string {
	switch {
	case p.Before != "":
		return "before " + p.Before
	case p.After != "":
		return "after " + p.After
	case p.Index != nil:
		return fmt.Sprintf("index %d", *p.Index)
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
			if seq, ok := f.treeSeq[id]; ok {
				if f.treePos == nil {
					f.treePos = map[string]int{}
				}
				pos := f.treePos[id]
				if pos >= len(seq) {
					pos = len(seq) - 1
				}
				f.treePos[id] = pos + 1
				return seq[pos], nil
			}
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
		notifications: func() ([]cmux.Notification, error) {
			f.notificationsN++
			if f.notificationsErr != nil {
				return nil, f.notificationsErr
			}
			return f.notifications, nil
		},
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
	// Restore polling is near-instant in tests (1ms, not 0 — a zero interval
	// would busy-spin the "never visible" cases for the whole timeout,
	// ballooning f.calls with tree reads); only the number of tree reads
	// matters here, not the real-time delay between them.
	oldInterval, oldTimeout := restorePollInterval, restorePollTimeout
	restorePollInterval = time.Millisecond
	restorePollTimeout = 20 * time.Millisecond
	t.Cleanup(func() {
		restorePollInterval = oldInterval
		restorePollTimeout = oldTimeout
	})
	f := &fakeTabOps{trees: map[string]*cmux.WorkspaceTree{wsID: sampleTree()}}
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
			{ID: wsID, Ref: "workspace:1", Title: "Alpha", CustomColor: &color, CurrentDirectory: dir, Selected: true},
			// Closed out of band between list and tree: reported, not fatal.
			{ID: goneID, Ref: "workspace:2", Title: "Beta", CurrentDirectory: dir},
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
	if a.ID != wsID || a.Title != "Alpha" || a.Color != "#AD1457" || !a.Selected || a.Layout == nil || len(a.Panes) != 3 || a.Error != "" {
		t.Fatalf("first workspace = %+v", a)
	}
	if b.ID != goneID || b.Error == "" || b.Layout != nil || b.Panes != nil {
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
		{"renames", "  New name ", "rename " + wsID + " New name"},
		{"empty clears", "", "clear-name " + wsID + ""},
		// Whitespace is not a title: it means "give the name back to cmux".
		{"whitespace clears", "   ", "clear-name " + wsID + ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, f := newTabServer(t)
			code, got := postCmux(t, s.handleCmuxRename, map[string]string{"id": wsID, "title": c.title})
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

func TestCmuxRenameRejectsNonUUIDID(t *testing.T) {
	s, f := newTabServer(t)
	code, _ := postCmux(t, s.handleCmuxRename, map[string]string{"id": "W", "title": "x"})
	if code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", code)
	}
	if len(f.calls) != 0 {
		t.Fatalf("called cmux on a non-UUID id: %q", f.calls)
	}
}

func TestCmuxColor(t *testing.T) {
	cases := []struct {
		color string
		code  int
		want  string
	}{
		{"#AD1457", http.StatusOK, "set-color " + wsID + " #AD1457"},
		{"teal", http.StatusOK, "set-color " + wsID + " teal"},
		{"", http.StatusOK, "clear-color " + wsID + ""},
		{"#12345", http.StatusBadRequest, ""},
		{"red; rm -rf", http.StatusBadRequest, ""},
	}
	t.Run("rejects a non-UUID id", func(t *testing.T) {
		s, f := newTabServer(t)
		code, _ := postCmux(t, s.handleCmuxColor, map[string]string{"id": "--action", "color": "teal"})
		if code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", code)
		}
		if len(f.calls) != 0 {
			t.Fatalf("called cmux on a non-UUID id: %q", f.calls)
		}
	})
	for _, c := range cases {
		t.Run(c.color, func(t *testing.T) {
			s, f := newTabServer(t)
			code, _ := postCmux(t, s.handleCmuxColor, map[string]string{"id": wsID, "color": c.color})
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
	code, got := postCmux(t, s.handleCmuxFocusTab, map[string]string{"id": wsID, "surface": "surface:2"})
	if code != http.StatusOK || !got.OK {
		t.Fatalf("code=%d got=%+v", code, got)
	}
	want := []string{"select " + wsID + "", "focus " + wsID + " surface:2", "activate"}
	if strings.Join(f.calls, "|") != strings.Join(want, "|") {
		t.Fatalf("calls = %q, want %q", f.calls, want)
	}
}

func TestCmuxFocusTabActivateFailureIsNotAFailure(t *testing.T) {
	s, f := newTabServer(t)
	f.failOn = "activate"
	if _, got := postCmux(t, s.handleCmuxFocusTab, map[string]string{"id": wsID, "surface": "surface:2"}); !got.OK {
		t.Fatalf("got %+v, want ok despite activate failing", got)
	}
}

func TestCmuxFocusTabReportsCmuxFailure(t *testing.T) {
	s, f := newTabServer(t)
	f.failOn = "focus"
	code, got := postCmux(t, s.handleCmuxFocusTab, map[string]string{"id": wsID, "surface": "surface:2"})
	if code != http.StatusOK || got.OK || got.Error == "" {
		t.Fatalf("code=%d got=%+v, want 200 ok:false with error", code, got)
	}
}

func TestCmuxFocusTabValidatesSurface(t *testing.T) {
	s, f := newTabServer(t)
	for _, bad := range []string{"", "surface:", "surface:1 --workspace X", "pane:1", "--help"} {
		if code, _ := postCmux(t, s.handleCmuxFocusTab, map[string]string{"id": wsID, "surface": bad}); code != http.StatusBadRequest {
			t.Errorf("surface %q: status = %d, want 400", bad, code)
		}
	}
	if len(f.calls) != 0 {
		t.Fatalf("called cmux on invalid input: %q", f.calls)
	}
}

func TestCmuxFocusTabRejectsNonUUIDID(t *testing.T) {
	s, f := newTabServer(t)
	code, _ := postCmux(t, s.handleCmuxFocusTab, map[string]string{"id": "--action", "surface": "surface:2"})
	if code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", code)
	}
	if len(f.calls) != 0 {
		t.Fatalf("called cmux on a non-UUID id: %q", f.calls)
	}
}

func TestCmuxWritesWhenUnavailable(t *testing.T) {
	s, f := newTabServer(t)
	t.Setenv("CMUX_SOCKET_PATH", "")
	code, got := postCmux(t, s.handleCmuxRename, map[string]string{"id": wsID, "title": "x"})
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
			code, got := postCmux(t, s.handleCmuxCloseTab, map[string]string{"id": wsID, "surface": c.surface, "type": c.typ, "title": c.title})
			if code != http.StatusOK {
				t.Fatalf("status = %d", code)
			}
			if c.wantClose {
				if !got.OK || !f.called("close "+wsID+" "+c.surface) {
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

func TestCmuxCloseTabRejectsNonUUIDID(t *testing.T) {
	s, f := newTabServer(t)
	code, _ := postCmux(t, s.handleCmuxCloseTab, map[string]string{"id": "W", "surface": "surface:2", "type": "browser", "title": "(5) inbox"})
	if code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", code)
	}
	if len(f.calls) != 0 {
		t.Fatalf("called cmux on a non-UUID id: %q", f.calls)
	}
}

func TestCmuxCloseTabTreeFailureIsNotStale(t *testing.T) {
	s, f := newTabServer(t)
	code, got := postCmux(t, s.handleCmuxCloseTab, map[string]string{"id": goneID, "surface": "surface:1", "type": "terminal", "title": "x"})
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
	return moveBody{ID: wsID, Surface: "surface:2", Type: "browser", Title: "(5) inbox", Pane: pane, Anchor: anchor}
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
		{"same pane before", moveOf("pane:1", agent("before")), "reorder " + wsID + " surface:2 before surface:1"},
		{"same pane to end", moveOf("pane:1", nil), "reorder " + wsID + " surface:2 end"},
		{"other pane after", moveOf("pane:2", notes("after")), "move " + wsID + " surface:2 pane:2 after surface:3"},
		{"other pane to end", moveOf("pane:2", nil), "move " + wsID + " surface:2 pane:2 end"},
		{"into an empty pane", moveOf("pane:4", nil), "move " + wsID + " surface:2 pane:4 end"},
		{"dragged tab changed", moveBody{ID: wsID, Surface: "surface:2", Type: "browser", Title: "(6) inbox", Pane: "pane:2"}, ""},
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

// callIndex returns the position of the first call matching prefix, or -1.
func callIndex(f *fakeTabOps, prefix string) int {
	for i, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			return i
		}
	}
	return -1
}

// treeAfterClose is sampleTree with surface removed from its pane, and
// optionally a different pane focused / a different tab selected in that
// pane — i.e. what a fresh `tree` read shows once cmux has processed a close.
func treeAfterClose(surface string, selectIn string) *cmux.WorkspaceTree {
	t := sampleTree()
	for pi, p := range t.Panes {
		var tabs []cmux.TreeTab
		for _, tab := range p.Tabs {
			if tab.Ref == surface {
				continue
			}
			tabs = append(tabs, tab)
		}
		t.Panes[pi].Tabs = tabs
	}
	if selectIn != "" {
		for pi, p := range t.Panes {
			for ti := range p.Tabs {
				t.Panes[pi].Tabs[ti].Selected = t.Panes[pi].Tabs[ti].Ref == selectIn
			}
		}
	}
	return t
}

func TestCmuxCloseTabRestoresFocusAndSelection(t *testing.T) {
	t.Run("closing an unselected tab issues no restore calls", func(t *testing.T) {
		s, f := newTabServer(t)
		after := treeAfterClose("surface:2", "surface:1") // surface:1 was already selected
		f.treeSeq = map[string][]*cmux.WorkspaceTree{wsID: {sampleTree(), after}}
		code, got := postCmux(t, s.handleCmuxCloseTab, map[string]string{"id": wsID, "surface": "surface:2", "type": "browser", "title": "(5) inbox"})
		if code != http.StatusOK || !got.OK {
			t.Fatalf("code=%d got=%+v", code, got)
		}
		if f.called("reorder") || f.called("focus") {
			t.Fatalf("unexpected restore calls: %q", f.calls)
		}
	})

	t.Run("closing the selected tab restores nothing in that pane, focus unchanged", func(t *testing.T) {
		s, f := newTabServer(t)
		after := treeAfterClose("surface:1", "surface:2") // cmux picked a neighbour
		f.treeSeq = map[string][]*cmux.WorkspaceTree{wsID: {sampleTree(), after}}
		code, got := postCmux(t, s.handleCmuxCloseTab, map[string]string{"id": wsID, "surface": "surface:1", "type": "terminal", "title": "◐ agent"})
		if code != http.StatusOK || !got.OK {
			t.Fatalf("code=%d got=%+v", code, got)
		}
		if f.called("reorder") || f.called("focus") {
			t.Fatalf("unexpected restore calls: %q", f.calls)
		}
	})

	t.Run("change never visible: no restore, still ok", func(t *testing.T) {
		s, f := newTabServer(t)
		// Every read after the guard still shows the closed tab present (so
		// `visible` never fires) — but WITH a selection change that a restore
		// would act on if it incorrectly proceeded anyway, so "no calls"
		// here actually demonstrates the skip, not just "nothing to restore".
		stillThere := sampleTree()
		for pi, p := range stillThere.Panes {
			if p.Ref == "pane:1" {
				stillThere.Panes[pi].Tabs[0].Selected = false // surface:1, was selected
				stillThere.Panes[pi].Tabs[1].Selected = true  // surface:2 (still present)
			}
		}
		f.treeSeq = map[string][]*cmux.WorkspaceTree{wsID: {sampleTree(), stillThere}}
		code, got := postCmux(t, s.handleCmuxCloseTab, map[string]string{"id": wsID, "surface": "surface:2", "type": "browser", "title": "(5) inbox"})
		if code != http.StatusOK || !got.OK {
			t.Fatalf("code=%d got=%+v, want ok even though the close never became visible", code, got)
		}
		if f.called("reorder") || f.called("focus") {
			t.Fatalf("unexpected restore calls: %q", f.calls)
		}
	})

	t.Run("a failing restore reorder still answers ok", func(t *testing.T) {
		s, f := newTabServer(t)
		// Close the tab that wasn't selected, but also move focus away so a
		// restore reorder is attempted (and made to fail).
		after := treeAfterClose("surface:2", "surface:1")
		after.Panes[0].Focused = false
		for i := range after.Panes {
			if after.Panes[i].Ref == "pane:2" {
				after.Panes[i].Focused = true
			}
		}
		f.treeSeq = map[string][]*cmux.WorkspaceTree{wsID: {sampleTree(), after}}
		f.failOn = "reorder"
		code, got := postCmux(t, s.handleCmuxCloseTab, map[string]string{"id": wsID, "surface": "surface:2", "type": "browser", "title": "(5) inbox"})
		if code != http.StatusOK || !got.OK {
			t.Fatalf("code=%d got=%+v, want ok despite the restore reorder failing", code, got)
		}
		if !f.called("reorder") {
			t.Fatalf("expected a (failing) restore reorder: %q", f.calls)
		}
	})
}

// treeAfterMove builds the tree cmux shows right after moving surface:2 from
// pane:1 to the end of pane:2: selected there, that pane focused, pane:1's
// selection untouched (surface:2 was not selected before the move).
func treeAfterMove() *cmux.WorkspaceTree {
	t := sampleTree()
	for pi, p := range t.Panes {
		if p.Ref == "pane:1" {
			t.Panes[pi].Tabs = []cmux.TreeTab{{Ref: "surface:1", Type: "terminal", Title: "◐ agent", Selected: true}}
			t.Panes[pi].Focused = false
		}
		if p.Ref == "pane:2" {
			t.Panes[pi].Focused = true
			t.Panes[pi].Tabs = []cmux.TreeTab{
				{Ref: "surface:3", Type: "markdown", Title: "notes.md", Selected: false},
				{Ref: "surface:2", Type: "browser", Title: "(5) inbox", Selected: true},
			}
		}
	}
	return t
}

func TestCmuxMoveTabRestoresFocusAndSelection(t *testing.T) {
	body := map[string]any{"id": wsID, "surface": "surface:2", "type": "browser", "title": "(5) inbox", "pane": "pane:2"}

	t.Run("restores the target pane's prior selection and the original focus, in that order", func(t *testing.T) {
		s, f := newTabServer(t)
		after := treeAfterMove()
		f.treeSeq = map[string][]*cmux.WorkspaceTree{wsID: {sampleTree(), after}}
		code, got := postCmux(t, s.handleCmuxMoveTab, body)
		if code != http.StatusOK || !got.OK {
			t.Fatalf("code=%d got=%+v", code, got)
		}
		iTarget := callIndex(f, "reorder "+wsID+" surface:3 index 0")
		iFocus := callIndex(f, "reorder "+wsID+" surface:1 index 0")
		if iTarget < 0 || iFocus < 0 {
			t.Fatalf("calls = %q, want restores of surface:3 then surface:1", f.calls)
		}
		if iTarget > iFocus {
			t.Fatalf("calls = %q, want the target pane restored before the originally focused pane", f.calls)
		}
	})

	t.Run("a lagging first read is retried until the move is visible", func(t *testing.T) {
		s, f := newTabServer(t)
		stale := sampleTree() // still shows the old layout, as if the write hasn't landed yet
		after := treeAfterMove()
		f.treeSeq = map[string][]*cmux.WorkspaceTree{wsID: {sampleTree(), stale, after}}
		code, got := postCmux(t, s.handleCmuxMoveTab, body)
		if code != http.StatusOK || !got.OK {
			t.Fatalf("code=%d got=%+v", code, got)
		}
		if !f.called("reorder " + wsID + " surface:1 index 0") {
			t.Fatalf("calls = %q, want focus restored from the later read", f.calls)
		}
	})

	t.Run("a same-pane reorder restores the previously selected tab", func(t *testing.T) {
		s, f := newTabServer(t)
		// Dragged before surface:1 (so the request and this "after" fixture
		// agree on where surface:2 lands: index 0, surface:1 pushed to 1).
		after := sampleTree()
		for pi, p := range after.Panes {
			if p.Ref == "pane:1" {
				after.Panes[pi].Tabs = []cmux.TreeTab{
					{Ref: "surface:2", Type: "browser", Title: "(5) inbox", Selected: true},
					{Ref: "surface:1", Type: "terminal", Title: "◐ agent", Selected: false},
				}
			}
		}
		f.treeSeq = map[string][]*cmux.WorkspaceTree{wsID: {sampleTree(), after}}
		code, got := postCmux(t, s.handleCmuxMoveTab, map[string]any{
			"id": wsID, "surface": "surface:2", "type": "browser", "title": "(5) inbox", "pane": "pane:1",
			"anchor": map[string]string{"surface": "surface:1", "type": "terminal", "title": "◐ agent", "position": "before"},
		})
		if code != http.StatusOK || !got.OK {
			t.Fatalf("code=%d got=%+v", code, got)
		}
		if !f.called("reorder " + wsID + " surface:1 index 1") {
			t.Fatalf("calls = %q, want surface:1 restored as selected", f.calls)
		}
	})

	t.Run("ref missing but unique title match restores by name", func(t *testing.T) {
		s, f := newTabServer(t)
		after := treeAfterMove()
		for pi, p := range after.Panes {
			if p.Ref == "pane:1" {
				// surface:1's ref changed, but it is still the only terminal
				// titled "agent" (glyph aside) in that pane.
				after.Panes[pi].Tabs = []cmux.TreeTab{{Ref: "surface:9", Type: "terminal", Title: "◑ agent", Selected: true}}
			}
		}
		f.treeSeq = map[string][]*cmux.WorkspaceTree{wsID: {sampleTree(), after}}
		code, got := postCmux(t, s.handleCmuxMoveTab, body)
		if code != http.StatusOK || !got.OK {
			t.Fatalf("code=%d got=%+v", code, got)
		}
		if !f.called("reorder " + wsID + " surface:9 index 0") {
			t.Fatalf("calls = %q, want the renamed-ref tab restored by name", f.calls)
		}
	})

	t.Run("change never visible: no restore, still ok", func(t *testing.T) {
		s, f := newTabServer(t)
		// surface:2 never shows up in pane:2 (so `visible` never fires), but
		// pane:2's recorded selection is changed anyway — a restore WOULD
		// act on that if it incorrectly proceeded, so "no reorder calls"
		// actually demonstrates the skip.
		stuck := sampleTree()
		for pi, p := range stuck.Panes {
			if p.Ref == "pane:2" {
				stuck.Panes[pi].Tabs[0].Selected = false // surface:3, was selected
			}
		}
		f.treeSeq = map[string][]*cmux.WorkspaceTree{wsID: {sampleTree(), stuck}}
		code, got := postCmux(t, s.handleCmuxMoveTab, body)
		if code != http.StatusOK || !got.OK {
			t.Fatalf("code=%d got=%+v, want ok even though the move never became visible", code, got)
		}
		if f.called("reorder") {
			t.Fatalf("unexpected restore calls: %q", f.calls)
		}
	})

	t.Run("moving the selected tab out of the originally focused pane restores focus via cmux's replacement selection", func(t *testing.T) {
		s, f := newTabServer(t)
		// Drag surface:1 — selected, in pane:1, which is also the originally
		// focused pane — out to pane:2. Its own recorded selection (itself)
		// is unrestorable (it's the moved tab), so the final focus reorder
		// must fall back to whatever cmux picked as pane:1's replacement
		// selection (surface:2).
		after := sampleTree()
		for pi, p := range after.Panes {
			if p.Ref == "pane:1" {
				after.Panes[pi].Tabs = []cmux.TreeTab{{Ref: "surface:2", Type: "browser", Title: "(5) inbox", Selected: true}}
				after.Panes[pi].Focused = false
			}
			if p.Ref == "pane:2" {
				after.Panes[pi].Focused = true
				after.Panes[pi].Tabs = []cmux.TreeTab{
					{Ref: "surface:3", Type: "markdown", Title: "notes.md", Selected: false},
					{Ref: "surface:1", Type: "terminal", Title: "◐ agent", Selected: true},
				}
			}
		}
		f.treeSeq = map[string][]*cmux.WorkspaceTree{wsID: {sampleTree(), after}}
		code, got := postCmux(t, s.handleCmuxMoveTab, map[string]any{"id": wsID, "surface": "surface:1", "type": "terminal", "title": "◐ agent", "pane": "pane:2"})
		if code != http.StatusOK || !got.OK {
			t.Fatalf("code=%d got=%+v", code, got)
		}
		if !f.called("reorder " + wsID + " surface:2 index 0") {
			t.Fatalf("calls = %q, want pane:1's replacement selection (surface:2) restored as the focus", f.calls)
		}
	})

	t.Run("ambiguous title match in a non-focused pane is skipped (focus restore still happens)", func(t *testing.T) {
		s, f := newTabServer(t)
		after := treeAfterMove()
		for pi, p := range after.Panes {
			if p.Ref == "pane:2" {
				// surface:3's ref changed, and there are now two equally
				// titled candidates: pane:2's prior selection can't be
				// resolved.
				after.Panes[pi].Tabs = []cmux.TreeTab{
					{Ref: "surface:30", Type: "markdown", Title: "notes.md", Selected: false},
					{Ref: "surface:31", Type: "markdown", Title: "notes.md", Selected: false},
					{Ref: "surface:2", Type: "browser", Title: "(5) inbox", Selected: true},
				}
			}
		}
		f.treeSeq = map[string][]*cmux.WorkspaceTree{wsID: {sampleTree(), after}}
		code, got := postCmux(t, s.handleCmuxMoveTab, body)
		if code != http.StatusOK || !got.OK {
			t.Fatalf("code=%d got=%+v", code, got)
		}
		if f.called("reorder "+wsID+" surface:30") || f.called("reorder "+wsID+" surface:31") {
			t.Fatalf("calls = %q, want the ambiguous match skipped", f.calls)
		}
		if !f.called("reorder " + wsID + " surface:1 index 0") {
			t.Fatalf("calls = %q, want focus still restored to the originally focused pane", f.calls)
		}
	})
}

func TestCmuxMoveTabValidation(t *testing.T) {
	cases := map[string]moveBody{
		"bad pane":           moveOf("pane", nil),
		"bad surface":        {ID: wsID, Surface: "surface:x", Pane: "pane:1"},
		"missing id":         {Surface: "surface:2", Pane: "pane:1"},
		"non-UUID id":        {ID: "W", Surface: "surface:2", Pane: "pane:1"},
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

// setCmuxListSingle points s.cmuxList at a single matched workspace (wsID)
// at dir, like the real list would for a worktree with one open workspace.
func setCmuxListSingle(s *Server, dir string) {
	s.cmuxList = func() ([]cmux.Workspace, error) {
		return []cmux.Workspace{{ID: wsID, Ref: "workspace:1", Title: "Alpha", CurrentDirectory: dir}}, nil
	}
}

func findTreeTab(t *testing.T, got cmuxTreeResponse, surface string) cmux.TreeTab {
	t.Helper()
	for _, ws := range got.Workspaces {
		for _, p := range ws.Panes {
			for _, tab := range p.Tabs {
				if tab.Ref == surface {
					return tab
				}
			}
		}
	}
	t.Fatalf("tab %s not found in %+v", surface, got)
	return cmux.TreeTab{}
}

func TestCmuxTreeMarksUnreadTab(t *testing.T) {
	s, f := newTabServer(t)
	dir := t.TempDir()
	setCmuxListSingle(s, dir)
	f.notifications = []cmux.Notification{
		{ID: "1", WorkspaceID: wsID, SurfaceRef: "surface:1", IsRead: false},
	}
	code, got := getTree(t, s, dir)
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if !findTreeTab(t, got, "surface:1").Unread {
		t.Fatal("want surface:1 marked unread")
	}
	if f.notificationsN != 1 {
		t.Fatalf("notifications called %d times, want 1", f.notificationsN)
	}
}

func TestCmuxTreeReadOnlyNotificationNotMarked(t *testing.T) {
	s, f := newTabServer(t)
	dir := t.TempDir()
	setCmuxListSingle(s, dir)
	f.notifications = []cmux.Notification{
		{ID: "1", WorkspaceID: wsID, SurfaceRef: "surface:1", IsRead: true},
	}
	_, got := getTree(t, s, dir)
	if findTreeTab(t, got, "surface:1").Unread {
		t.Fatal("a read-only notification must not mark the tab unread")
	}
}

func TestCmuxTreeSameSurfaceOtherWorkspaceNotMarked(t *testing.T) {
	s, f := newTabServer(t)
	dir := t.TempDir()
	setCmuxListSingle(s, dir)
	f.notifications = []cmux.Notification{
		{ID: "1", WorkspaceID: goneID, SurfaceRef: "surface:1", IsRead: false},
	}
	_, got := getTree(t, s, dir)
	if findTreeTab(t, got, "surface:1").Unread {
		t.Fatal("a notification for a different workspace must not mark the tab unread")
	}
}

func TestCmuxTreeUnreadMatchesWorkspaceIDCaseInsensitively(t *testing.T) {
	s, f := newTabServer(t)
	dir := t.TempDir()
	setCmuxListSingle(s, dir)
	f.notifications = []cmux.Notification{
		{ID: "1", WorkspaceID: strings.ToLower(wsID), SurfaceRef: "surface:1", IsRead: false},
	}
	_, got := getTree(t, s, dir)
	if !findTreeTab(t, got, "surface:1").Unread {
		t.Fatal("want workspace id matched case-insensitively")
	}
}

func TestCmuxTreeNotificationsErrorDegradesGracefully(t *testing.T) {
	s, f := newTabServer(t)
	dir := t.TempDir()
	setCmuxListSingle(s, dir)
	f.notificationsErr = errors.New("boom")
	code, got := getTree(t, s, dir)
	if code != http.StatusOK || !got.Available {
		t.Fatalf("code=%d available=%v, want 200 available", code, got.Available)
	}
	if findTreeTab(t, got, "surface:1").Unread {
		t.Fatal("a notifications error must not mark anything unread")
	}
	if len(got.Workspaces) != 1 || got.Workspaces[0].Panes == nil {
		t.Fatalf("tree must still be intact despite the notifications error: %+v", got)
	}
}

func TestCmuxTreeNoMatchedWorkspaceSkipsNotifications(t *testing.T) {
	s, f := newTabServer(t)
	other := t.TempDir()
	dir := t.TempDir()
	s.cmuxList = func() ([]cmux.Workspace, error) {
		return []cmux.Workspace{{ID: wsID, Ref: "workspace:1", Title: "Alpha", CurrentDirectory: other}}, nil
	}
	code, got := getTree(t, s, dir)
	if code != http.StatusOK || len(got.Workspaces) != 0 {
		t.Fatalf("code=%d got=%+v, want 200 with no workspaces", code, got)
	}
	if f.notificationsN != 0 {
		t.Fatal("notifications must not be called when no workspace matched")
	}
}
