package cmux

import (
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

// Two windows, so a tab is found whichever window its workspace is in. Only
// browser tabs with a URL come back: terminals and unloaded browser tabs
// (url null) have nothing to match against.
const browserTabsJSON = `{"windows": [
  {"workspaces": [
    {"id": "AAAA-UUID", "ref": "workspace:1", "title": "Alpha", "selected": true, "panes": [
      {"ref": "pane:1", "surfaces": [
        {"ref": "surface:1", "type": "terminal", "url": null},
        {"ref": "surface:2", "type": "browser", "url": "https://example.com/a"},
        {"ref": "surface:3", "type": "browser", "url": null}
      ]}
    ]}
  ]},
  {"workspaces": [
    {"id": "BBBB-UUID", "ref": "workspace:2", "title": "Beta", "selected": false, "panes": [
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
	want := []BrowserTab{
		{WorkspaceID: "AAAA-UUID", WorkspaceRef: "workspace:1", WorkspaceTitle: "Alpha", WorkspaceSelected: true, Ref: "surface:2", URL: "https://example.com/a"},
		{WorkspaceID: "BBBB-UUID", WorkspaceRef: "workspace:2", WorkspaceTitle: "Beta", Ref: "surface:7", URL: "https://example.com/b"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
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
