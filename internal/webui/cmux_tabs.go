package webui

import (
	"net/http"

	"github.com/mturley/worktree/internal/cmux"
)

// cmuxTabOps is every cmux call the cmux tab makes, so handler tests can run
// without a cmux binary. Package cmux's own exec stub is unexported, the same
// reason the cmuxList seam exists.
type cmuxTabOps struct {
	tree            func(id string) (*cmux.WorkspaceTree, error)
	selectWorkspace func(id string) error
	focusTab        func(id, surface string) error
	activate        func() error
	closeTab        func(id, surface string) error
	reorderTab      func(id, surface string, pos cmux.TabPosition) error
	moveTab         func(id, surface, pane string, pos cmux.TabPosition) error
	rename          func(id, title string) error
	clearName       func(id string) error
	setColor        func(id, color string) error
	clearColor      func(id string) error
}

func realCmuxTabOps() cmuxTabOps {
	return cmuxTabOps{
		tree:            cmux.Tree,
		selectWorkspace: cmux.SelectWorkspace,
		focusTab:        cmux.FocusTab,
		activate:        cmux.Activate,
		closeTab:        cmux.CloseTab,
		reorderTab:      cmux.ReorderTab,
		moveTab:         cmux.MoveTab,
		rename:          cmux.RenameWorkspace,
		clearName:       cmux.ClearWorkspaceName,
		setColor:        cmux.SetWorkspaceColor,
		clearColor:      cmux.ClearWorkspaceColor,
	}
}

func (s *Server) tabOps() cmuxTabOps {
	if s.cmuxTabs != nil {
		return *s.cmuxTabs
	}
	return realCmuxTabOps()
}

type cmuxTreeWorkspaceDTO struct {
	ID       string           `json:"id"`
	Ref      string           `json:"ref"`
	Title    string           `json:"title"`
	Color    string           `json:"color,omitempty"`
	Selected bool             `json:"selected"`
	Layout   *cmux.LayoutNode `json:"layout,omitempty"`
	Panes    []cmux.TreePane  `json:"panes,omitempty"`
	// Error is set, and Layout/Panes left out, when this one workspace's tree
	// could not be read (e.g. it was closed between the list and the tree).
	Error string `json:"error,omitempty"`
}

type cmuxTreeResponse struct {
	Available  bool                   `json:"available"`
	Workspaces []cmuxTreeWorkspaceDTO `json:"workspaces"`
}

// handleCmuxTree: GET /api/cmux/tree?path=<worktree>
//
// Matches workspaces to the path exactly as /api/cmux does, then reads each
// one's tree. Polled every 5s, but only while the cmux tab is open, so its
// cost is one `cmux workspace list` plus one `cmux tree` per matched
// workspace for the page you are actually looking at. Degrades like
// /api/cmux: never a 5xx over a missing terminal multiplexer.
func (s *Server) handleCmuxTree(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	unavailable := cmuxTreeResponse{Workspaces: []cmuxTreeWorkspaceDTO{}}
	if !cmux.IsAvailable() {
		writeJSON(w, http.StatusOK, unavailable)
		return
	}
	list := cmux.ListWorkspaces
	if s.cmuxList != nil {
		list = s.cmuxList
	}
	workspaces, err := list()
	if err != nil {
		writeJSON(w, http.StatusOK, unavailable)
		return
	}
	ops := s.tabOps()
	out := cmuxTreeResponse{Available: true, Workspaces: []cmuxTreeWorkspaceDTO{}}
	for _, ws := range cmux.Match(workspaces, []string{path})[path] {
		dto := cmuxTreeWorkspaceDTO{ID: ws.ID, Ref: ws.Ref, Title: ws.DisplayTitle(), Selected: ws.Selected}
		if ws.CustomColor != nil {
			dto.Color = *ws.CustomColor
		}
		if tree, err := ops.tree(ws.ID); err != nil {
			dto.Error = err.Error()
		} else {
			layout := tree.Layout
			dto.Layout = &layout
			dto.Panes = tree.Panes
		}
		out.Workspaces = append(out.Workspaces, dto)
	}
	writeJSON(w, http.StatusOK, out)
}
