package webui

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"unicode"

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

const staleTabMessage = "That tab changed since the list loaded. Check it and try again."

// normalizeTitle drops status symbols at either end before titles are
// compared. cmux agent terminals animate a glyph at the start ("◐ x" →
// "◑ x") on their own, and pi puts an emoji status at the end
// ("pi - x:🚧"); neither means a different tab. Brackets, parentheses and
// ellipses are punctuation, not symbols, so "(5) worktree" and
// "[KEY-1] page" are compared whole.
func normalizeTitle(t string) string {
	return strings.TrimFunc(t, func(r rune) bool {
		return unicode.IsSymbol(r) || unicode.IsSpace(r) || unicode.In(r, unicode.Mn, unicode.Cf)
	})
}

// guardTab reports the pane holding the named tab, if the tab still matches
// what the user saw: same ref, same type, same (normalised) title.
func guardTab(tree *cmux.WorkspaceTree, want cmuxTabRef) (string, bool) {
	tab, pane, ok := tree.FindTab(want.Surface)
	if !ok || tab.Type != want.Type || normalizeTitle(tab.Title) != normalizeTitle(want.Title) {
		return "", false
	}
	return pane, true
}

func writeStaleTab(w http.ResponseWriter) {
	writeJSON(w, http.StatusOK, cmuxActionResponse{OK: false, Stale: true, Error: staleTabMessage})
}

type cmuxCloseTabRequest struct {
	ID string `json:"id"`
	cmuxTabRef
}

// handleCmuxCloseTab: POST /api/cmux/close-tab.
//
// The ref came from a poll up to 5s old and closing is destructive, so the
// tree is re-read and the tab must still be the one the user saw. A gap of
// milliseconds remains between the check and the close; cmux has no
// compare-and-close to remove it.
func (s *Server) handleCmuxCloseTab(w http.ResponseWriter, r *http.Request) {
	var req cmuxCloseTabRequest
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
	tree, err := ops.tree(req.ID)
	if err != nil {
		respondCmuxAction(w, err)
		return
	}
	if _, ok := guardTab(tree, req.cmuxTabRef); !ok {
		writeStaleTab(w)
		return
	}
	respondCmuxAction(w, ops.closeTab(req.ID, req.Surface))
}

type cmuxAnchor struct {
	cmuxTabRef
	Position string `json:"position"` // "before" | "after"
}

type cmuxMoveTabRequest struct {
	ID string `json:"id"`
	cmuxTabRef
	Pane   string      `json:"pane"`
	Anchor *cmuxAnchor `json:"anchor"`
}

// handleCmuxMoveTab: POST /api/cmux/move-tab.
//
// A drop names an anchor tab rather than an index: an index from a stale
// poll points at whatever has since moved into that slot, while an anchor is
// checked. Both the dragged tab and the anchor are guarded like close. No
// anchor means the end of the target pane. Same pane → reorder-surface (cmux
// refuses an anchor in another pane there); other pane → move-surface.
func (s *Server) handleCmuxMoveTab(w http.ResponseWriter, r *http.Request) {
	var req cmuxMoveTabRequest
	if !decodeCmuxRequest(w, r, &req) {
		return
	}
	switch {
	case req.ID == "":
		writeError(w, http.StatusBadRequest, "missing id")
		return
	case !surfaceRefRe.MatchString(req.Surface):
		writeError(w, http.StatusBadRequest, "invalid surface")
		return
	case !paneRefRe.MatchString(req.Pane):
		writeError(w, http.StatusBadRequest, "invalid pane")
		return
	}
	if a := req.Anchor; a != nil {
		switch {
		case !surfaceRefRe.MatchString(a.Surface):
			writeError(w, http.StatusBadRequest, "invalid anchor surface")
			return
		case a.Surface == req.Surface:
			writeError(w, http.StatusBadRequest, "a tab cannot be its own anchor")
			return
		case a.Position != "before" && a.Position != "after":
			writeError(w, http.StatusBadRequest, "anchor position must be before or after")
			return
		}
	}
	if cmuxUnavailable(w) {
		return
	}
	ops := s.tabOps()
	tree, err := ops.tree(req.ID)
	if err != nil {
		respondCmuxAction(w, err)
		return
	}
	from, ok := guardTab(tree, req.cmuxTabRef)
	if !ok {
		writeStaleTab(w)
		return
	}
	var pos cmux.TabPosition
	if a := req.Anchor; a != nil {
		anchorPane, ok := guardTab(tree, a.cmuxTabRef)
		if !ok || anchorPane != req.Pane {
			writeStaleTab(w)
			return
		}
		if a.Position == "before" {
			pos.Before = a.Surface
		} else {
			pos.After = a.Surface
		}
	} else if !tree.HasPane(req.Pane) {
		writeStaleTab(w)
		return
	}
	if req.Pane == from {
		respondCmuxAction(w, ops.reorderTab(req.ID, req.Surface, pos))
	} else {
		respondCmuxAction(w, ops.moveTab(req.ID, req.Surface, req.Pane, pos))
	}
}
