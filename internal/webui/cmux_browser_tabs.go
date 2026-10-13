package webui

import (
	"net/http"

	"github.com/mturley/worktree/internal/cmux"
)

type cmuxBrowserTabDTO struct {
	WorkspaceID       string `json:"workspaceId"`
	WorkspaceRef      string `json:"workspaceRef"`
	WorkspaceTitle    string `json:"workspaceTitle"`
	WorkspaceSelected bool   `json:"workspaceSelected"`
	// Pane and Layout draw the workspace's splits with this tab's pane
	// marked, in the switch button's tooltip. Layout is absent when cmux's
	// could not be read.
	Pane    string           `json:"pane"`
	Layout  *cmux.LayoutNode `json:"layout,omitempty"`
	Surface string           `json:"surface"`
	URL     string           `json:"url"`
}

type cmuxBrowserTabsResponse struct {
	Available bool                `json:"available"`
	Tabs      []cmuxBrowserTabDTO `json:"tabs"`
}

// handleCmuxBrowserTabs: GET /api/cmux/browser-tabs
//
// Every loaded browser tab in cmux, across all workspaces and windows, so a
// resource's detail card can offer to switch to a tab already showing it.
// One `cmux tree --all` per call, shared by every card on the page. A read
// failure degrades to available:false, like /api/cmux/tree: the card then
// just offers to open a new tab.
func (s *Server) handleCmuxBrowserTabs(w http.ResponseWriter, r *http.Request) {
	out := cmuxBrowserTabsResponse{Tabs: []cmuxBrowserTabDTO{}}
	if !s.cmuxEnabled() {
		writeJSON(w, http.StatusOK, out)
		return
	}
	tabs, err := s.tabOps().browserTabs()
	if err != nil {
		writeJSON(w, http.StatusOK, out)
		return
	}
	out.Available = true
	for _, t := range tabs {
		out.Tabs = append(out.Tabs, cmuxBrowserTabDTO{
			WorkspaceID:       t.WorkspaceID,
			WorkspaceRef:      t.WorkspaceRef,
			WorkspaceTitle:    t.WorkspaceTitle,
			WorkspaceSelected: t.WorkspaceSelected,
			Pane:              t.Pane,
			Layout:            t.Layout,
			Surface:           t.Ref,
			URL:               t.URL,
		})
	}
	writeJSON(w, http.StatusOK, out)
}
