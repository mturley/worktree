package webui

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"
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
	notifications   func() ([]cmux.Notification, error)
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
		notifications:   cmux.ListNotifications,
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
	workspaces, err := s.listCmuxWorkspaces()
	if err != nil {
		writeJSON(w, http.StatusOK, unavailable)
		return
	}
	ops := s.tabOps()
	matched := cmux.Match(workspaces, []string{path})[path]
	out := cmuxTreeResponse{Available: true, Workspaces: []cmuxTreeWorkspaceDTO{}}
	if len(matched) == 0 {
		writeJSON(w, http.StatusOK, out)
		return
	}
	unread := unreadSurfaces(ops)
	for _, ws := range matched {
		dto := cmuxTreeWorkspaceDTO{ID: ws.ID, Ref: ws.Ref, Title: ws.DisplayTitle(), Selected: ws.Selected}
		if ws.CustomColor != nil {
			dto.Color = *ws.CustomColor
		}
		if tree, err := ops.tree(ws.ID); err != nil {
			dto.Error = err.Error()
		} else {
			layout := tree.Layout
			dto.Layout = &layout
			dto.Panes = markUnreadTabs(tree.Panes, ws.ID, unread)
		}
		out.Workspaces = append(out.Workspaces, dto)
	}
	writeJSON(w, http.StatusOK, out)
}

// unreadSurfaces builds the set of (lower(workspace_id), surface_ref) pairs
// with at least one unread notification. A read error leaves the set empty
// — dots are best-effort, so a failure here must never fail the tree
// response or mark anything unread.
func unreadSurfaces(ops cmuxTabOps) map[[2]string]bool {
	set := map[[2]string]bool{}
	if ops.notifications == nil {
		return set
	}
	notifications, err := ops.notifications()
	if err != nil {
		return set
	}
	for _, n := range notifications {
		if !n.IsRead {
			set[[2]string{strings.ToLower(n.WorkspaceID), n.SurfaceRef}] = true
		}
	}
	return set
}

// markUnreadTabs copies panes/tabs (never mutating the tree in place, which
// callers besides this one may still hold a reference to) and sets Unread
// on each tab whose (workspace, surface ref) is in the unread set.
func markUnreadTabs(panes []cmux.TreePane, workspaceID string, unread map[[2]string]bool) []cmux.TreePane {
	if len(unread) == 0 {
		return panes
	}
	wsKey := strings.ToLower(workspaceID)
	out := make([]cmux.TreePane, len(panes))
	for i, p := range panes {
		tabs := make([]cmux.TreeTab, len(p.Tabs))
		copy(tabs, p.Tabs)
		for j, t := range tabs {
			if unread[[2]string{wsKey, t.Ref}] {
				tabs[j].Unread = true
			}
		}
		out[i] = cmux.TreePane{Ref: p.Ref, Focused: p.Focused, Tabs: tabs}
	}
	return out
}

var (
	surfaceRefRe = regexp.MustCompile(`^surface:\d+$`)
	paneRefRe    = regexp.MustCompile(`^pane:\d+$`)
	hexColorRe   = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)
	uuidRe       = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$`)
)

// validWorkspaceID checks a request's workspace id the same way surface/pane
// refs are checked: an empty id is "missing id" (400, handled by the caller
// before this), but any non-empty, non-UUID string must never reach `--workspace
// <id>` or `workspace select <id>` — cmux workspace ids are UUIDs.
func validWorkspaceID(w http.ResponseWriter, id string) bool {
	if !uuidRe.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid id")
		return false
	}
	return true
}

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
	if !validWorkspaceID(w, req.ID) {
		return
	}
	if cmuxUnavailable(w) {
		return
	}
	ops := s.tabOps()
	if title := strings.TrimSpace(req.Title); title == "" {
		respondCmuxAction(w, ops.clearName(req.ID))
	} else {
		s.cmuxTitleMu.Lock()
		defer s.cmuxTitleMu.Unlock()
		respondCmuxAction(w, ops.rename(req.ID, cmux.WithUnreadPrefix(title, s.workspaceHasUnreadPrefix(req.ID))))
	}
}

// workspaceHasUnreadPrefix reports whether the workspace's title currently
// carries the unread mailbox, which the UI never shows (see cmux_unread.go),
// so a rename typed there can keep it. A failed lookup says no: the title
// lands bare and the unread sync puts the mailbox back on its next pass.
func (s *Server) workspaceHasUnreadPrefix(id string) bool {
	workspaces, err := s.listCmuxWorkspaces()
	if err != nil {
		return false
	}
	for _, ws := range workspaces {
		if strings.EqualFold(ws.ID, id) {
			return ws.HasUnreadPrefix()
		}
	}
	return false
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
	if !validWorkspaceID(w, req.ID) {
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
	if !validWorkspaceID(w, req.ID) {
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

// restorePollInterval and restorePollTimeout bound how long a restore waits
// for cmux's tree to catch up with a close or move before giving up (reads
// lag writes by a few hundred ms). Package vars so tests can set the
// interval to 0.
var (
	restorePollInterval = 150 * time.Millisecond
	restorePollTimeout  = time.Second
)

// paneSnapshot is one pane's previously selected tab, recorded before a
// close/move acts, so it can be restored afterwards.
type paneSnapshot struct {
	pane string
	tab  cmuxTabRef
	has  bool
}

// recordPane snapshots a pane's currently selected tab, if it has one.
func recordPane(tree *cmux.WorkspaceTree, pane string) paneSnapshot {
	for _, p := range tree.Panes {
		if p.Ref != pane {
			continue
		}
		for _, t := range p.Tabs {
			if t.Selected {
				return paneSnapshot{pane: pane, tab: cmuxTabRef{Surface: t.Ref, Type: t.Type, Title: t.Title}, has: true}
			}
		}
	}
	return paneSnapshot{pane: pane}
}

// recordPanes snapshots several panes, skipping empty refs and duplicates.
func recordPanes(tree *cmux.WorkspaceTree, panes ...string) []paneSnapshot {
	var out []paneSnapshot
	seen := map[string]bool{}
	for _, p := range panes {
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, recordPane(tree, p))
	}
	return out
}

func focusedPaneRef(tree *cmux.WorkspaceTree) string {
	for _, p := range tree.Panes {
		if p.Focused {
			return p.Ref
		}
	}
	return ""
}

func tabIndex(tree *cmux.WorkspaceTree, pane, ref string) int {
	for _, p := range tree.Panes {
		if p.Ref != pane {
			continue
		}
		for i, t := range p.Tabs {
			if t.Ref == ref {
				return i
			}
		}
	}
	return -1
}

// resolveTab finds a recorded tab in the fresh tree, within the pane it was
// recorded in: by ref first, then — the ref having gone missing — by type
// and normalised title, only when exactly one tab in that pane matches.
func resolveTab(fresh *cmux.WorkspaceTree, pane string, want cmuxTabRef) (cmux.TreeTab, bool) {
	for _, p := range fresh.Panes {
		if p.Ref != pane {
			continue
		}
		for _, t := range p.Tabs {
			if t.Ref == want.Surface {
				return t, true
			}
		}
		var match cmux.TreeTab
		count := 0
		for _, t := range p.Tabs {
			if t.Type == want.Type && normalizeTitle(t.Title) == normalizeTitle(want.Title) {
				match = t
				count++
			}
		}
		if count == 1 {
			return match, true
		}
		return cmux.TreeTab{}, false
	}
	return cmux.TreeTab{}, false
}

// restoreAfterChange puts the user's prior selection and pane focus back
// after a close or move, which cmux otherwise jumps elsewhere: it waits for
// the tree to reflect the operation (`visible`), restores each recorded
// pane's previously selected tab (skipping the tab that was itself closed or
// moved), and — last — restores the originally focused pane's focus via an
// in-place reorder (never focus-panel, which also switches the active
// workspace; see cmux-tab-followup brief). Restore failures are swallowed:
// the close/move already succeeded, and the caller always replies ok.
func (s *Server) restoreAfterChange(ops cmuxTabOps, wsID, skipSurface string, snapshots []paneSnapshot, origFocused string, visible func(*cmux.WorkspaceTree) bool) {
	deadline := time.Now().Add(restorePollTimeout)
	var fresh *cmux.WorkspaceTree
	for {
		t, err := ops.tree(wsID)
		if err == nil && visible(t) {
			fresh = t
			break
		}
		if time.Now().After(deadline) {
			return
		}
		time.Sleep(restorePollInterval)
	}

	needsFocus := origFocused != "" && focusedPaneRef(fresh) != origFocused
	var focusTab cmux.TreeTab
	haveFocusTab := false
	// An in-place reorder in ANY pane other than the originally focused one
	// always re-focuses that pane (same cmux quirk the restore itself relies
	// on) — so even a restore that starts out not needing to touch focus can
	// end up stealing it, and must still finish with the final reorder below.
	stoleFocus := false

	for _, snap := range snapshots {
		if !snap.has || snap.tab.Surface == skipSurface {
			continue
		}
		tab, ok := resolveTab(fresh, snap.pane, snap.tab)
		if !ok {
			continue
		}
		if snap.pane == origFocused && needsFocus {
			focusTab, haveFocusTab = tab, true
			continue // restored, if needed, as part of the final focus reorder below
		}
		if tab.Selected {
			continue // nothing to restore
		}
		if idx := tabIndex(fresh, snap.pane, tab.Ref); idx >= 0 {
			_ = ops.reorderTab(wsID, tab.Ref, cmux.TabPosition{Index: &idx})
			if snap.pane != origFocused {
				stoleFocus = true
			}
		}
	}

	needsFocus = needsFocus || stoleFocus
	if !needsFocus || origFocused == "" {
		return
	}
	if !haveFocusTab {
		for _, p := range fresh.Panes {
			if p.Ref != origFocused {
				continue
			}
			for _, t := range p.Tabs {
				if t.Selected {
					focusTab, haveFocusTab = t, true
				}
			}
		}
	}
	if !haveFocusTab {
		return
	}
	if idx := tabIndex(fresh, origFocused, focusTab.Ref); idx >= 0 {
		_ = ops.reorderTab(wsID, focusTab.Ref, cmux.TabPosition{Index: &idx})
	}
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
//
// A close moves cmux's own selection/focus (a neighbour gets selected in the
// closed tab's pane) which the user did not ask for, so the prior state is
// recorded before closing and restored after — see restoreAfterChange.
func (s *Server) handleCmuxCloseTab(w http.ResponseWriter, r *http.Request) {
	var req cmuxCloseTabRequest
	if !decodeCmuxRequest(w, r, &req) {
		return
	}
	if req.ID == "" {
		writeError(w, http.StatusBadRequest, "missing id")
		return
	}
	if !validWorkspaceID(w, req.ID) {
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
	pane, ok := guardTab(tree, req.cmuxTabRef)
	if !ok {
		writeStaleTab(w)
		return
	}
	origFocused := focusedPaneRef(tree)
	snapshots := recordPanes(tree, pane, origFocused)
	if err := ops.closeTab(req.ID, req.Surface); err != nil {
		respondCmuxAction(w, err)
		return
	}
	s.restoreAfterChange(ops, req.ID, req.Surface, snapshots, origFocused, func(t *cmux.WorkspaceTree) bool {
		_, _, found := t.FindTab(req.Surface)
		return !found
	})
	respondCmuxAction(w, nil)
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
	case !uuidRe.MatchString(req.ID):
		writeError(w, http.StatusBadRequest, "invalid id")
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
	origFocused := focusedPaneRef(tree)
	snapshots := recordPanes(tree, from, req.Pane, origFocused)
	samePane := req.Pane == from
	beforeIndex := -1
	if samePane {
		beforeIndex = tabIndex(tree, from, req.Surface)
	}
	var opErr error
	if samePane {
		opErr = ops.reorderTab(req.ID, req.Surface, pos)
	} else {
		opErr = ops.moveTab(req.ID, req.Surface, req.Pane, pos)
	}
	if opErr != nil {
		respondCmuxAction(w, opErr)
		return
	}
	target := req.Pane
	// The immediate post-op read is almost always still the old layout (a
	// `tree` straight after a move/reorder was seen to lag), so "the tab is
	// in the target pane" alone is nearly always true on a stale read too —
	// it's where the tab STARTED for a same-pane reorder, and cmux hasn't
	// necessarily caught up on a cross-pane one either. The signal cmux
	// reliably produces once the op has actually landed is that it also
	// selects the moved tab and focuses its pane (regardless of --focus);
	// wait for that. A same-pane reorder additionally counts as visible if
	// the tab's index actually changed, in case cmux ever reorders without
	// changing selection/focus (e.g. a true no-op reorder).
	visible := func(t *cmux.WorkspaceTree) bool {
		tab, pane, found := t.FindTab(req.Surface)
		if !found || pane != target {
			return false
		}
		focused := false
		for _, p := range t.Panes {
			if p.Ref == pane && p.Focused {
				focused = true
			}
		}
		if tab.Selected && focused {
			return true
		}
		return samePane && tabIndex(t, pane, req.Surface) != beforeIndex
	}
	s.restoreAfterChange(ops, req.ID, req.Surface, snapshots, origFocused, visible)
	respondCmuxAction(w, nil)
}
