package cmux

import (
	"encoding/json"
	"testing"
)

type testLayout struct {
	Direction string       `json:"direction"`
	Children  []testLayout `json:"children"`
	Pane      *struct {
		Surfaces []struct {
			Type    string `json:"type"`
			URL     string `json:"url"`
			Command string `json:"command"`
		} `json:"surfaces"`
	} `json:"pane"`
}

func parseLayout(t *testing.T, s string) testLayout {
	t.Helper()
	var l testLayout
	if err := json.Unmarshal([]byte(s), &l); err != nil {
		t.Fatalf("unmarshalling layout: %v", err)
	}
	return l
}

func TestBuildLayoutWithoutURLsUsesATerminalOnTheLeft(t *testing.T) {
	l := parseLayout(t, BuildLayout("http://localhost:8475", nil))

	left := l.Children[0]
	if got := len(left.Pane.Surfaces); got != 1 {
		t.Fatalf("left pane surfaces = %d, want 1", got)
	}
	if got := left.Pane.Surfaces[0].Type; got != "terminal" {
		t.Errorf("left pane surface type = %q, want terminal", got)
	}
}

func TestBuildLayoutWithURLsOpensThemAsBrowserTabsOnTheLeft(t *testing.T) {
	l := parseLayout(t, BuildLayout("http://localhost:8475", []string{"https://example.test/pr/1", "https://example.test/issue/2"}))

	left := l.Children[0]
	if got := len(left.Pane.Surfaces); got != 2 {
		t.Fatalf("left pane surfaces = %d, want 2", got)
	}
	for i, want := range []string{"https://example.test/pr/1", "https://example.test/issue/2"} {
		s := left.Pane.Surfaces[i]
		if s.Type != "browser" || s.URL != want {
			t.Errorf("left surface %d = %q %q, want browser %q", i, s.Type, s.URL, want)
		}
	}
}

func TestBuildLayoutTopRightHoldsOnlyThePinnedUIBrowser(t *testing.T) {
	l := parseLayout(t, BuildLayout("http://localhost:8475", nil))

	topRight := l.Children[1].Children[0]
	if got := len(topRight.Pane.Surfaces); got != 1 {
		t.Fatalf("top-right pane surfaces = %d, want 1", got)
	}
	s := topRight.Pane.Surfaces[0]
	if s.Type != "browser" || s.URL != "http://localhost:8475" {
		t.Errorf("top-right surface = %q %q, want browser http://localhost:8475", s.Type, s.URL)
	}
}

func TestBuildLayoutTopRightFallsBackToATerminalWithoutAUIURL(t *testing.T) {
	l := parseLayout(t, BuildLayout("", nil))

	topRight := l.Children[1].Children[0]
	if got := len(topRight.Pane.Surfaces); got != 1 {
		t.Fatalf("top-right pane surfaces = %d, want 1", got)
	}
	if got := topRight.Pane.Surfaces[0].Type; got != "terminal" {
		t.Errorf("top-right surface type = %q, want terminal", got)
	}
}

func TestBuildLayoutKeepsTheInfoTerminalBottomRight(t *testing.T) {
	l := parseLayout(t, BuildLayout("http://localhost:8475", nil))

	bottomRight := l.Children[1].Children[1]
	s := bottomRight.Pane.Surfaces[0]
	if s.Type != "terminal" || s.Command != "worktree info" {
		t.Errorf("bottom-right surface = %q %q, want terminal `worktree info`", s.Type, s.Command)
	}
}
