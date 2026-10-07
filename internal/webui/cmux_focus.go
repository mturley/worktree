package webui

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/registry"
)

// cmuxFocusMsg is the stream's cmux_focus event: the workspace cmux just
// focused, and the first registered worktree open in it ("" when none is).
// Every tab receives it; only one with "Follow cmux focus" on acts on it.
type cmuxFocusMsg struct {
	WorkspaceID string `json:"workspace_id"`
	Path        string `json:"path"`
}

// cmuxFocusHub fans focus changes out to every open stream. last dedupes:
// window.focused fires whenever cmux comes forward, but a tab should move
// only when the focused workspace actually changes.
type cmuxFocusHub struct {
	mu   sync.Mutex
	subs map[chan cmuxFocusMsg]struct{}
	last string
}

func (s *Server) focusHub() *cmuxFocusHub {
	s.focusOnce.Do(func() {
		s.focus = &cmuxFocusHub{subs: make(map[chan cmuxFocusMsg]struct{})}
	})
	return s.focus
}

// subscribe registers a stream. The channel is buffered and sends never
// block, so a stalled stream misses a focus change rather than holding up
// the others — a later change supersedes it anyway.
func (h *cmuxFocusHub) subscribe() (<-chan cmuxFocusMsg, func()) {
	ch := make(chan cmuxFocusMsg, 4)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		delete(h.subs, ch)
		h.mu.Unlock()
	}
}

// changed records id as focused and reports whether it differs from before.
func (h *cmuxFocusHub) changed(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if id == h.last {
		return false
	}
	h.last = id
	return true
}

func (h *cmuxFocusHub) publish(msg cmuxFocusMsg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- msg:
		default:
		}
	}
}

// StartCmuxFocusWatch follows cmux's focus events for the life of the
// server, restarting the event stream when it ends. A no-op outside cmux,
// where the UI hides the toggle that would use it.
func (s *Server) StartCmuxFocusWatch() (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	available := cmux.IsAvailable
	if s.cmuxAvailable != nil {
		available = s.cmuxAvailable
	}
	if !available() {
		return cancel
	}
	watch := cmux.WatchFocus
	if s.cmuxWatchFocus != nil {
		watch = s.cmuxWatchFocus
	}
	go func() {
		for {
			err := watch(ctx, s.onCmuxFocus)
			if ctx.Err() != nil {
				return
			}
			s.logger().Printf("cmux focus watch: %v; retrying", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
			}
		}
	}()
	return cancel
}

// onCmuxFocus publishes a focus change with the worktree it lands on.
func (s *Server) onCmuxFocus(workspaceID string) {
	hub := s.focusHub()
	if !hub.changed(workspaceID) {
		return
	}
	hub.publish(cmuxFocusMsg{WorkspaceID: workspaceID, Path: s.worktreeForWorkspace(workspaceID)})
}

// handleCmuxFocused: GET /api/cmux/focused
//
// The workspace cmux has selected right now, as a cmux_focus message. Turning
// "Follow cmux focus" on asks for it, so the tab goes where cmux already is
// instead of waiting for the next switch. Every failure is an empty message,
// which the tab treats as "nowhere to go".
func (s *Server) handleCmuxFocused(w http.ResponseWriter, r *http.Request) {
	available := cmux.IsAvailable
	if s.cmuxAvailable != nil {
		available = s.cmuxAvailable
	}
	if !available() {
		writeJSON(w, http.StatusOK, cmuxFocusMsg{})
		return
	}
	workspaces, err := s.listCmuxWorkspaces()
	if err != nil {
		writeJSON(w, http.StatusOK, cmuxFocusMsg{})
		return
	}
	for _, ws := range workspaces {
		if ws.Selected {
			writeJSON(w, http.StatusOK, cmuxFocusMsg{WorkspaceID: ws.ID, Path: s.worktreeIn(workspaces, ws.ID)})
			return
		}
	}
	writeJSON(w, http.StatusOK, cmuxFocusMsg{})
}

// worktreeForWorkspace is the first registered worktree, in registry order,
// open in the workspace, or "" when there is none or it cannot be told.
// Matched through cmux.Match so symlinked paths agree with /api/cmux.
func (s *Server) worktreeForWorkspace(workspaceID string) string {
	workspaces, err := s.listCmuxWorkspaces()
	if err != nil {
		return ""
	}
	return s.worktreeIn(workspaces, workspaceID)
}

// worktreeIn is worktreeForWorkspace against a listing already in hand.
func (s *Server) worktreeIn(workspaces []cmux.Workspace, workspaceID string) string {
	if s.DB == nil {
		return ""
	}
	var ws []cmux.Workspace
	for _, w := range workspaces {
		if w.ID == workspaceID {
			ws = append(ws, w)
		}
	}
	if len(ws) == 0 {
		return ""
	}
	entries, err := registry.List(s.DB)
	if err != nil {
		return ""
	}
	paths := make([]string, 0, len(entries))
	for _, e := range entries {
		paths = append(paths, e.Path)
	}
	matches := cmux.Match(ws, paths)
	for _, p := range paths {
		if len(matches[p]) > 0 {
			return p
		}
	}
	return ""
}
