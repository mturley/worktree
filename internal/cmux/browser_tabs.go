package cmux

import (
	"encoding/json"
	"fmt"
)

// BrowserTab is a browser tab showing a URL, in any workspace of any window.
type BrowserTab struct {
	WorkspaceID       string
	WorkspaceRef      string
	WorkspaceTitle    string
	WorkspaceSelected bool // selected within its window
	// Pane holds the tab; Layout is its workspace's split layout, nil when
	// cmux's layout did not check out (the tab is still listed).
	Pane   string
	Layout *LayoutNode
	Ref    string
	URL    string
}

// BrowserTabs lists every loaded browser tab across all windows, from one
// `cmux tree --all`, so finding a page anywhere in cmux costs a single call
// however many workspaces there are.
func BrowserTabs() ([]BrowserTab, error) {
	out, err := treeOutput("--all")
	if err != nil {
		return nil, err
	}
	return parseBrowserTabs(out)
}

// parseBrowserTabs skips terminals and unloaded browser tabs (url null):
// there is nothing to match them against. Never nil. A bad layout leaves
// Layout nil rather than failing the list, since only a diagram needs it.
func parseBrowserTabs(data []byte) ([]BrowserTab, error) {
	var raw rawTree
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parsing workspace tree: %w", err)
	}
	tabs := []BrowserTab{}
	for _, win := range raw.Windows {
		for _, ws := range win.Workspaces {
			var layout *LayoutNode
			if l, err := convertLayout(ws.Layout, paneRefs(ws.Panes)); err == nil {
				layout = &l
			}
			for _, p := range ws.Panes {
				for _, s := range p.Surfaces {
					if s.Type != "browser" || s.URL == nil || *s.URL == "" {
						continue
					}
					tabs = append(tabs, BrowserTab{
						WorkspaceID:       ws.ID,
						WorkspaceRef:      ws.Ref,
						WorkspaceTitle:    ws.Title,
						WorkspaceSelected: ws.Selected,
						Pane:              p.Ref,
						Layout:            layout,
						Ref:               s.Ref,
						URL:               *s.URL,
					})
				}
			}
		}
	}
	return tabs, nil
}

// paneRefs is just enough of a WorkspaceTree for convertLayout to check
// that every leaf names a real pane.
func paneRefs(panes []rawPane) *WorkspaceTree {
	tree := &WorkspaceTree{Panes: make([]TreePane, 0, len(panes))}
	for _, p := range panes {
		tree.Panes = append(tree.Panes, TreePane{Ref: p.Ref})
	}
	return tree
}
