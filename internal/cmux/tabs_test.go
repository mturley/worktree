package cmux

import (
	"reflect"
	"testing"
)

func TestTabCommandArgs(t *testing.T) {
	cases := []struct {
		name string
		run  func() error
		want []string
	}{
		{"focus", func() error { return FocusTab("W", "surface:3") },
			[]string{"focus-panel", "--panel", "surface:3", "--workspace", "W"}},
		{"close", func() error { return CloseTab("W", "surface:3") },
			[]string{"close-surface", "--surface", "surface:3", "--workspace", "W"}},
		{"clear name", func() error { return ClearWorkspaceName("W") },
			[]string{"workspace-action", "--workspace", "W", "--action", "clear-name"}},
		{"clear color", func() error { return ClearWorkspaceColor("W") },
			[]string{"workspace-action", "--workspace", "W", "--action", "clear-color"}},
		{"reorder before", func() error { return ReorderTab("W", "surface:3", TabPosition{Before: "surface:1"}) },
			[]string{"reorder-surface", "--surface", "surface:3", "--workspace", "W", "--before", "surface:1"}},
		{"reorder after", func() error { return ReorderTab("W", "surface:3", TabPosition{After: "surface:1"}) },
			[]string{"reorder-surface", "--surface", "surface:3", "--workspace", "W", "--after", "surface:1"}},
		// cmux clamps an index past the end to last, so a large one means "end".
		{"reorder to end", func() error { return ReorderTab("W", "surface:3", TabPosition{}) },
			[]string{"reorder-surface", "--surface", "surface:3", "--workspace", "W", "--index", "9999"}},
		{"move before", func() error { return MoveTab("W", "surface:3", "pane:2", TabPosition{Before: "surface:7"}) },
			[]string{"move-surface", "--surface", "surface:3", "--workspace", "W", "--pane", "pane:2", "--before", "surface:7"}},
		{"move to end", func() error { return MoveTab("W", "surface:3", "pane:2", TabPosition{}) },
			[]string{"move-surface", "--surface", "surface:3", "--workspace", "W", "--pane", "pane:2", "--index", "9999"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := stubCmux(t, "true")
			if err := c.run(); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(*got, c.want) {
				t.Fatalf("args = %q, want %q", *got, c.want)
			}
		})
	}
}

func TestTabCommandsReportFailure(t *testing.T) {
	stubCmux(t, "false")
	for name, run := range map[string]func() error{
		"focus":   func() error { return FocusTab("W", "surface:1") },
		"close":   func() error { return CloseTab("W", "surface:1") },
		"reorder": func() error { return ReorderTab("W", "surface:1", TabPosition{}) },
		"move":    func() error { return MoveTab("W", "surface:1", "pane:1", TabPosition{}) },
	} {
		if err := run(); err == nil {
			t.Errorf("%s: want error when cmux fails", name)
		}
	}
}
