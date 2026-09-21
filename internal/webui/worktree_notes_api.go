package webui

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/notes"
	"github.com/mturley/worktree/internal/registry"
)

// maxNotesBytes caps one worktree's notes. Generous for free text, small
// enough that a runaway paste cannot bloat the DB or a cmux description.
const maxNotesBytes = 64 << 10

type worktreeNotesDTO struct {
	Notes     string `json:"notes"`
	SyncCmux  bool   `json:"sync_cmux"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

// Outcomes of mirroring notes to the cmux workspace description.
const (
	cmuxSyncOff     = "off"     // the worktree's sync setting is off
	cmuxSyncOK      = "ok"      // description updated
	cmuxSyncSkipped = "skipped" // cmux unavailable, or not exactly one workspace
	cmuxSyncFailed  = "failed"  // cmux refused the update
)

type setWorktreeNotesRequest struct {
	Path     string `json:"path"`
	Notes    string `json:"notes"`
	SyncCmux bool   `json:"sync_cmux"`
}

type setWorktreeNotesResponse struct {
	worktreeNotesDTO
	CmuxSync  string `json:"cmux_sync"`
	CmuxError string `json:"cmux_error,omitempty"`
}

// handleGetWorktreeNotes: GET /api/worktree-notes?path=<path>
//
// Its own endpoint rather than a field on /api/worktree-info, so that a git
// status refetch can never overwrite notes being typed, and a save never
// costs a git subprocess.
func (s *Server) handleGetWorktreeNotes(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	n, err := notes.Get(s.DB, path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, worktreeNotesDTO{Notes: n.Text, SyncCmux: n.SyncCmux, UpdatedAt: n.UpdatedAt})
}

// handleSetWorktreeNotes: POST /api/worktree-notes
//
// Saves notes and the sync setting together, then — if sync is on — mirrors
// the notes to the worktree's cmux workspace description. The notes are
// committed FIRST: a cmux failure is reported in cmux_sync, never as a failed
// save, because the notes themselves are safe.
//
// The workspace is re-resolved from the path on every save rather than taken
// from the client. Refs are index-based and shift; the UUID from a fresh list
// is what is targeted, and only when exactly one workspace matches — with two
// there is no right answer.
func (s *Server) handleSetWorktreeNotes(w http.ResponseWriter, r *http.Request) {
	var req setWorktreeNotesRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*maxNotesBytes)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	if len(req.Notes) > maxNotesBytes {
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("notes exceed %d KB", maxNotesBytes>>10))
		return
	}
	entry, err := registry.Get(s.DB, req.Path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if entry == nil {
		writeError(w, http.StatusNotFound, "worktree not registered")
		return
	}

	n, err := notes.Set(s.DB, req.Path, req.Notes, req.SyncCmux)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := setWorktreeNotesResponse{
		worktreeNotesDTO: worktreeNotesDTO{Notes: n.Text, SyncCmux: n.SyncCmux, UpdatedAt: n.UpdatedAt},
		CmuxSync:         cmuxSyncOff,
	}
	if n.SyncCmux {
		resp.CmuxSync, resp.CmuxError = s.syncNotesToCmux(req.Path, n.Text)
	}
	writeJSON(w, http.StatusOK, resp)
}

// syncNotesToCmux mirrors text to the description of path's one cmux
// workspace, returning the outcome and, when not ok, why.
func (s *Server) syncNotesToCmux(path, text string) (string, string) {
	if !cmux.IsAvailable() {
		return cmuxSyncSkipped, "cmux is not available"
	}
	list := cmux.ListWorkspaces
	if s.cmuxList != nil {
		list = s.cmuxList
	}
	workspaces, err := list()
	if err != nil {
		return cmuxSyncFailed, err.Error()
	}
	hits := cmux.Match(workspaces, []string{path})[path]
	if len(hits) != 1 {
		return cmuxSyncSkipped, fmt.Sprintf("expected exactly one cmux workspace, found %d", len(hits))
	}
	target := hits[0].ID
	if target == "" {
		target = hits[0].Ref
	}
	set := cmux.SetWorkspaceDescription
	if s.cmuxSetDescription != nil {
		set = s.cmuxSetDescription
	}
	if err := set(target, text); err != nil {
		return cmuxSyncFailed, err.Error()
	}
	return cmuxSyncOK, ""
}
