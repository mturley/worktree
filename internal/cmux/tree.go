package cmux

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// LayoutNode is one node of a workspace's split layout: either a leaf naming a
// pane, or a split of exactly two children. Split is the first child's share
// of the space, strictly between 0 and 1. The JSON tags are the web API's
// shape, which is why the raw cmux shape is parsed separately below.
type LayoutNode struct {
	Pane      string       `json:"pane,omitempty"`
	Direction string       `json:"direction,omitempty"` // "horizontal" | "vertical"
	Split     float64      `json:"split,omitempty"`
	Children  []LayoutNode `json:"children,omitempty"`
}

// TreeTab is one tab (cmux calls it a surface) in a pane.
type TreeTab struct {
	Ref      string `json:"ref"`   // surface:N
	Title    string `json:"title"`
	Type     string `json:"type"`  // "terminal" | "browser" | "markdown" | others, passed through
	URL      string `json:"url,omitempty"` // empty when cmux reports null (terminals, unloaded browser tabs)
	Selected bool   `json:"selected"`      // selected within its pane
}

type TreePane struct {
	Ref     string    `json:"ref"`
	Focused bool      `json:"focused"`
	Tabs    []TreeTab `json:"tabs"` // never nil
}

// WorkspaceTree is one workspace's panes and how they are arranged.
type WorkspaceTree struct {
	Layout LayoutNode
	Panes  []TreePane
}

// FindTab returns the tab with this ref and the ref of the pane holding it.
func (t *WorkspaceTree) FindTab(ref string) (TreeTab, string, bool) {
	for _, p := range t.Panes {
		for _, tab := range p.Tabs {
			if tab.Ref == ref {
				return tab, p.Ref, true
			}
		}
	}
	return TreeTab{}, "", false
}

func (t *WorkspaceTree) HasPane(ref string) bool {
	for _, p := range t.Panes {
		if p.Ref == ref {
			return true
		}
	}
	return false
}

// The raw `cmux tree --json` shape, verified against cmux 0.64.25. Only the
// fields used here are declared; everything else is ignored.
type rawTree struct {
	Windows []struct {
		Workspaces []struct {
			ID     string    `json:"id"`
			Layout rawLayout `json:"layout"`
			Panes  []rawPane `json:"panes"`
		} `json:"workspaces"`
	} `json:"windows"`
}

type rawLayout struct {
	Pane *struct {
		Ref string `json:"ref"`
	} `json:"pane"`
	Direction string      `json:"direction"`
	Split     *float64    `json:"split"`
	Children  []rawLayout `json:"children"`
}

type rawPane struct {
	Ref      string       `json:"ref"`
	Focused  bool         `json:"focused"`
	Surfaces []rawSurface `json:"surfaces"`
}

type rawSurface struct {
	Ref            string  `json:"ref"`
	Title          string  `json:"title"`
	Type           string  `json:"type"`
	URL            *string `json:"url"`
	SelectedInPane bool    `json:"selected_in_pane"`
}

// Tree reads one workspace's panes, tabs and split layout.
func Tree(workspaceID string) (*WorkspaceTree, error) {
	out, err := cmuxCmd("tree", "--json", "--workspace", workspaceID).Output()
	if err != nil {
		return nil, fmt.Errorf("reading workspace tree: %w", err)
	}
	return parseTree(out, workspaceID)
}

// parseTree is strict about the layout — a node that is neither a pane nor a
// two-child split, a ratio outside (0, 1), or a leaf naming a pane missing
// from the pane list is an error rather than a guess the UI would then draw.
func parseTree(data []byte, workspaceID string) (*WorkspaceTree, error) {
	var raw rawTree
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parsing workspace tree: %w", err)
	}
	for _, win := range raw.Windows {
		for _, ws := range win.Workspaces {
			if !strings.EqualFold(ws.ID, workspaceID) {
				continue
			}
			tree := &WorkspaceTree{Panes: make([]TreePane, 0, len(ws.Panes))}
			for _, p := range ws.Panes {
				pane := TreePane{Ref: p.Ref, Focused: p.Focused, Tabs: make([]TreeTab, 0, len(p.Surfaces))}
				for _, s := range p.Surfaces {
					tab := TreeTab{Ref: s.Ref, Title: s.Title, Type: s.Type, Selected: s.SelectedInPane}
					if s.URL != nil {
						tab.URL = *s.URL
					}
					pane.Tabs = append(pane.Tabs, tab)
				}
				tree.Panes = append(tree.Panes, pane)
			}
			layout, err := convertLayout(ws.Layout, tree)
			if err != nil {
				return nil, fmt.Errorf("workspace %s layout: %w", workspaceID, err)
			}
			tree.Layout = layout
			return tree, nil
		}
	}
	return nil, fmt.Errorf("workspace %s not found in cmux tree output", workspaceID)
}

func convertLayout(n rawLayout, tree *WorkspaceTree) (LayoutNode, error) {
	if n.Pane != nil {
		if !tree.HasPane(n.Pane.Ref) {
			return LayoutNode{}, fmt.Errorf("layout names pane %q, which is not in the pane list", n.Pane.Ref)
		}
		return LayoutNode{Pane: n.Pane.Ref}, nil
	}
	if n.Direction != "horizontal" && n.Direction != "vertical" {
		return LayoutNode{}, errors.New("layout node is neither a pane nor a horizontal/vertical split")
	}
	if len(n.Children) != 2 {
		return LayoutNode{}, fmt.Errorf("split has %d children, want 2", len(n.Children))
	}
	if n.Split == nil || *n.Split <= 0 || *n.Split >= 1 {
		return LayoutNode{}, errors.New("split ratio missing or outside (0, 1)")
	}
	first, err := convertLayout(n.Children[0], tree)
	if err != nil {
		return LayoutNode{}, err
	}
	second, err := convertLayout(n.Children[1], tree)
	if err != nil {
		return LayoutNode{}, err
	}
	return LayoutNode{Direction: n.Direction, Split: *n.Split, Children: []LayoutNode{first, second}}, nil
}
