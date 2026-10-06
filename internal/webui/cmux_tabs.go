package webui

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

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

var (
	surfaceRefRe = regexp.MustCompile(`^surface:\d+$`)
	paneRefRe    = regexp.MustCompile(`^pane:\d+$`)
	hexColorRe   = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)
)

// cmuxTabRef names a tab the way the user saw it: its ref plus the type and
// title it had in the list they acted on.
type cmuxTabRef struct {
	Surface string `json:"surface"`
	Type    string `json:"type"`
	Title   string `json:"title"`
}

func decodeCmuxRequest(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	return true
}

// cmuxUnavailable answers for a write when cmux cannot be reached, and says
// whether it did.
func cmuxUnavailable(w http.ResponseWriter) bool {
	if cmux.IsAvailable() {
		return false
	}
	writeJSON(w, http.StatusOK, cmuxActionResponse{OK: false, Error: "cmux is not running"})
	return true
}

func respondCmuxAction(w http.ResponseWriter, err error) {
	if err != nil {
		writeJSON(w, http.StatusOK, cmuxActionResponse{OK: false, Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, cmuxActionResponse{OK: true})
}

type cmuxRenameRequest struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// handleCmuxRename: POST /api/cmux/rename. An empty (or whitespace) title
// clears the custom name, handing the title back to cmux.
func (s *Server) handleCmuxRename(w http.ResponseWriter, r *http.Request) {
	var req cmuxRenameRequest
	if !decodeCmuxRequest(w, r, &req) {
		return
	}
	if req.ID == "" {
		writeError(w, http.StatusBadRequest, "missing id")
		return
	}
	if cmuxUnavailable(w) {
		return
	}
	ops := s.tabOps()
	if title := strings.TrimSpace(req.Title); title == "" {
		respondCmuxAction(w, ops.clearName(req.ID))
	} else {
		respondCmuxAction(w, ops.rename(req.ID, title))
	}
}

type cmuxColorRequest struct {
	ID    string `json:"id"`
	Color string `json:"color"`
}

func validCmuxColor(c string) bool {
	if hexColorRe.MatchString(c) {
		return true
	}
	for _, n := range cmux.NamedColors {
		if strings.EqualFold(n.Name, c) {
			return true
		}
	}
	return false
}

// handleCmuxColor: POST /api/cmux/color. Empty clears; otherwise a named
// colour or #RRGGBB, checked here so nothing else reaches the exec.
func (s *Server) handleCmuxColor(w http.ResponseWriter, r *http.Request) {
	var req cmuxColorRequest
	if !decodeCmuxRequest(w, r, &req) {
		return
	}
	if req.ID == "" {
		writeError(w, http.StatusBadRequest, "missing id")
		return
	}
	if req.Color != "" && !validCmuxColor(req.Color) {
		writeError(w, http.StatusBadRequest, "color must be a cmux colour name or #RRGGBB")
		return
	}
	if cmuxUnavailable(w) {
		return
	}
	ops := s.tabOps()
	if req.Color == "" {
		respondCmuxAction(w, ops.clearColor(req.ID))
	} else {
		respondCmuxAction(w, ops.setColor(req.ID, req.Color))
	}
}

type cmuxFocusTabRequest struct {
	ID      string `json:"id"`
	Surface string `json:"surface"`
}

// handleCmuxFocusTab: POST /api/cmux/focus-tab. Selects the workspace, then
// the tab, then raises cmux (activation failing is not the switch failing,
// as in handleCmuxSelect). Deliberately unguarded: landing on the wrong tab
// is harmless and undone by clicking again.
func (s *Server) handleCmuxFocusTab(w http.ResponseWriter, r *http.Request) {
	var req cmuxFocusTabRequest
	if !decodeCmuxRequest(w, r, &req) {
		return
	}
	if req.ID == "" {
		writeError(w, http.StatusBadRequest, "missing id")
		return
	}
	if !surfaceRefRe.MatchString(req.Surface) {
		writeError(w, http.StatusBadRequest, "invalid surface")
		return
	}
	if cmuxUnavailable(w) {
		return
	}
	ops := s.tabOps()
	if err := ops.selectWorkspace(req.ID); err != nil {
		respondCmuxAction(w, err)
		return
	}
	if err := ops.focusTab(req.ID, req.Surface); err != nil {
		respondCmuxAction(w, err)
		return
	}
	_ = ops.activate()
	respondCmuxAction(w, nil)
}
