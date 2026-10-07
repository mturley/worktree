package cmux

import (
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

func loadTreeFixture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/tree.json")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParseTreeLayout(t *testing.T) {
	tree, err := parseTree(loadTreeFixture(t), "AAAA-UUID")
	if err != nil {
		t.Fatal(err)
	}
	want := LayoutNode{
		Direction: "horizontal",
		Split:     0.4,
		Children: []LayoutNode{
			{Pane: "pane:1"},
			{Direction: "vertical", Split: 0.75, Children: []LayoutNode{{Pane: "pane:2"}, {Pane: "pane:3"}}},
		},
	}
	if !reflect.DeepEqual(tree.Layout, want) {
		t.Fatalf("layout = %+v, want %+v", tree.Layout, want)
	}
}

func TestParseTreePanesAndTabs(t *testing.T) {
	tree, err := parseTree(loadTreeFixture(t), "AAAA-UUID")
	if err != nil {
		t.Fatal(err)
	}
	if len(tree.Panes) != 3 {
		t.Fatalf("got %d panes, want 3", len(tree.Panes))
	}
	if !tree.Panes[1].Focused || tree.Panes[0].Focused {
		t.Fatalf("focused flags wrong: %+v", tree.Panes)
	}
	wantPane2 := []TreeTab{
		{Ref: "surface:3", Type: "browser", Title: "Example page", URL: "https://example.com/page", Selected: true},
		// A browser tab can have url:null (seen live on unloaded tabs).
		{Ref: "surface:4", Type: "browser", Title: "Unloaded tab"},
		// Types are open-ended: markdown viewers exist too.
		{Ref: "surface:5", Type: "markdown", Title: "notes.md"},
	}
	if !reflect.DeepEqual(tree.Panes[1].Tabs, wantPane2) {
		t.Fatalf("pane:2 tabs = %+v, want %+v", tree.Panes[1].Tabs, wantPane2)
	}
	if tree.Panes[0].Tabs[0].URL != "" {
		t.Fatalf("terminal url = %q, want empty", tree.Panes[0].Tabs[0].URL)
	}
}

func TestParseTreeEmptyPaneHasNonNilTabs(t *testing.T) {
	// A pane with no tabs shows up transiently while tabs move; it must parse
	// and serialize as [] (not null) so the UI can map over it.
	tree, err := parseTree(loadTreeFixture(t), "AAAA-UUID")
	if err != nil {
		t.Fatal(err)
	}
	if tree.Panes[2].Tabs == nil || len(tree.Panes[2].Tabs) != 0 {
		t.Fatalf("pane:3 tabs = %#v, want empty non-nil", tree.Panes[2].Tabs)
	}
}

func TestParseTreeMatchesIDCaseInsensitively(t *testing.T) {
	if _, err := parseTree(loadTreeFixture(t), "aaaa-uuid"); err != nil {
		t.Fatal(err)
	}
}

func TestParseTreeMissingWorkspace(t *testing.T) {
	if _, err := parseTree(loadTreeFixture(t), "NOPE"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("err = %v, want not-found error", err)
	}
}

func TestParseTreeRejectsMalformedLayouts(t *testing.T) {
	const panes = `"panes":[{"ref":"pane:1","surfaces":[]},{"ref":"pane:2","surfaces":[]}]`
	cases := map[string]string{
		"invalid json":         `{`,
		"one child":            `{"windows":[{"workspaces":[{"id":"W","layout":{"direction":"horizontal","split":0.5,"children":[{"pane":{"ref":"pane:1"}}]},` + panes + `}]}]}`,
		"ratio out of range":   `{"windows":[{"workspaces":[{"id":"W","layout":{"direction":"horizontal","split":1.5,"children":[{"pane":{"ref":"pane:1"}},{"pane":{"ref":"pane:2"}}]},` + panes + `}]}]}`,
		"missing ratio":        `{"windows":[{"workspaces":[{"id":"W","layout":{"direction":"vertical","children":[{"pane":{"ref":"pane:1"}},{"pane":{"ref":"pane:2"}}]},` + panes + `}]}]}`,
		"unknown direction":    `{"windows":[{"workspaces":[{"id":"W","layout":{"direction":"diagonal","split":0.5,"children":[{"pane":{"ref":"pane:1"}},{"pane":{"ref":"pane:2"}}]},` + panes + `}]}]}`,
		"leaf names lost pane": `{"windows":[{"workspaces":[{"id":"W","layout":{"pane":{"ref":"pane:9"}},` + panes + `}]}]}`,
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := parseTree([]byte(data), "W"); err == nil {
				t.Fatal("want error, got nil")
			}
		})
	}
}

func TestTreeRunsCmuxTreeForTheWorkspace(t *testing.T) {
	got := stubCmux(t, "true") // empty output: the parse fails, but the args are recorded
	if _, err := Tree("AAAA-UUID"); err == nil {
		t.Fatal("want parse error on empty output")
	}
	want := []string{"tree", "--json", "--workspace", "AAAA-UUID"}
	if !reflect.DeepEqual(*got, want) {
		t.Fatalf("args = %q, want %q", *got, want)
	}
}

func TestTreeErrorIncludesStderr(t *testing.T) {
	orig := cmuxCmd
	t.Cleanup(func() { cmuxCmd = orig })
	cmuxCmd = func(args ...string) *exec.Cmd { return exec.Command("sh", "-c", "echo boom >&2; exit 1") }
	_, err := Tree("AAAA-UUID")
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v, want it to carry cmux's stderr", err)
	}
}

func TestFindTabAndHasPane(t *testing.T) {
	tree, err := parseTree(loadTreeFixture(t), "AAAA-UUID")
	if err != nil {
		t.Fatal(err)
	}
	tab, pane, ok := tree.FindTab("surface:5")
	if !ok || pane != "pane:2" || tab.Title != "notes.md" {
		t.Fatalf("FindTab = %+v, %q, %v", tab, pane, ok)
	}
	if _, _, ok := tree.FindTab("surface:99"); ok {
		t.Fatal("FindTab found a missing ref")
	}
	if !tree.HasPane("pane:3") || tree.HasPane("pane:9") {
		t.Fatal("HasPane wrong")
	}
}
