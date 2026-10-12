package cmux

import (
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

// Two windows, so a tab is found whichever window its workspace is in. Only
// browser tabs with a URL come back: terminals and unloaded browser tabs
// (url null) have nothing to match against. Each tab carries its workspace's
// layout and the pane holding it, for the switch button's pane diagram.
const browserTabsJSON = `{"windows": [
  {"workspaces": [
    {"id": "AAAA-UUID", "ref": "workspace:1", "title": "Alpha", "selected": true,
     "layout": {"pane": {"ref": "pane:1"}}, "panes": [
      {"ref": "pane:1", "surfaces": [
        {"ref": "surface:1", "type": "terminal", "url": null},
        {"ref": "surface:2", "type": "browser", "url": "https://example.com/a"},
        {"ref": "surface:3", "type": "browser", "url": null}
      ]}
    ]}
  ]},
  {"workspaces": [
    {"id": "BBBB-UUID", "ref": "workspace:2", "title": "Beta", "selected": false,
     "layout": {"direction": "horizontal", "split": 0.6, "children": [
       {"pane": {"ref": "pane:2"}}, {"pane": {"ref": "pane:3"}}]}, "panes": [
      {"ref": "pane:2", "surfaces": [
        {"ref": "surface:7", "type": "browser", "url": "https://example.com/b"}
      ]},
      {"ref": "pane:3", "surfaces": []}
    ]}
  ]}
]}`

func TestParseBrowserTabs(t *testing.T) {
	got, err := parseBrowserTabs([]byte(browserTabsJSON))
	if err != nil {
		t.Fatal(err)
	}
	beta := &LayoutNode{Direction: "horizontal", Split: 0.6, Children: []LayoutNode{{Pane: "pane:2"}, {Pane: "pane:3"}}}
	want := []BrowserTab{
		{WorkspaceID: "AAAA-UUID", WorkspaceRef: "workspace:1", WorkspaceTitle: "Alpha", WorkspaceSelected: true, Pane: "pane:1", Layout: &LayoutNode{Pane: "pane:1"}, Ref: "surface:2", URL: "https://example.com/a"},
		{WorkspaceID: "BBBB-UUID", WorkspaceRef: "workspace:2", WorkspaceTitle: "Beta", Pane: "pane:2", Layout: beta, Ref: "surface:7", URL: "https://example.com/b"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

// A layout that does not check out costs only the diagram, never the tab:
// switching to it works without one.
func TestParseBrowserTabsKeepsTabWhenLayoutIsBad(t *testing.T) {
	got, err := parseBrowserTabs([]byte(`{"windows": [{"workspaces": [
	  {"id": "A", "ref": "workspace:1", "title": "Alpha",
	   "layout": {"pane": {"ref": "pane:9"}}, "panes": [
	    {"ref": "pane:1", "surfaces": [{"ref": "surface:2", "type": "browser", "url": "https://example.com/a"}]}
	  ]}
	]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Layout != nil || got[0].Pane != "pane:1" {
		t.Fatalf("got %+v, want the tab with its pane and no layout", got)
	}
}

func TestParseBrowserTabsNoneIsEmptyNotNil(t *testing.T) {
	got, err := parseBrowserTabs([]byte(`{"windows": []}`))
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("got %#v, %v; want an empty non-nil slice", got, err)
	}
}

func TestParseBrowserTabsRejectsGarbage(t *testing.T) {
	if _, err := parseBrowserTabs([]byte("nope")); err == nil {
		t.Fatal("want a parse error")
	}
}

func TestBrowserTabsReadsEveryWindow(t *testing.T) {
	got := stubCmux(t, "true") // empty output: the parse fails, but the args are recorded
	if _, err := BrowserTabs(); err == nil {
		t.Fatal("want parse error on empty output")
	}
	want := []string{"tree", "--json", "--all"}
	if !reflect.DeepEqual(*got, want) {
		t.Fatalf("args = %q, want %q", *got, want)
	}
}

func TestBrowserTabsErrorIncludesStderr(t *testing.T) {
	orig := cmuxCmd
	t.Cleanup(func() { cmuxCmd = orig })
	cmuxCmd = func(args ...string) *exec.Cmd { return exec.Command("sh", "-c", "echo boom >&2; exit 1") }
	_, err := BrowserTabs()
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v, want it to carry cmux's stderr", err)
	}
}
