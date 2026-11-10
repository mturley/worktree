package webui

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/mturley/worktree/internal/notes"
	"github.com/mturley/worktree/internal/registry"
)

// maxNotesBytes caps one worktree's notes. Generous for free text, small
// enough that a runaway paste cannot bloat the DB or a cmux description.
const maxNotesBytes = 64 << 10

type worktreeNotesDTO struct {
	Notes      string `json:"notes"`
	SyncCmux   bool   `json:"sync_cmux"`
	ShowOnHome bool   `json:"show_on_home"`
	UpdatedAt  string `json:"updated_at,omitempty"`
}

func newWorktreeNotesDTO(n notes.Notes) worktreeNotesDTO {
	return worktreeNotesDTO{Notes: n.Text, SyncCmux: n.SyncCmux, ShowOnHome: n.ShowOnHome, UpdatedAt: n.UpdatedAt}
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
	// ShowOnHome is optional: absent keeps the stored setting, so a client
	// that predates it (say, an old tab's keepalive save) cannot turn it off.
	ShowOnHome *bool `json:"show_on_home,omitempty"`
	// BaseNotes is the text the client last loaded. When the stored notes
	// have moved on since, the save is merged with them rather than
	// overwriting. Absent (an older tab) overwrites.
	BaseNotes *string `json:"base_notes,omitempty"`
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
	writeJSON(w, http.StatusOK, newWorktreeNotesDTO(n))
}

// handleSetWorktreeNotes: POST /api/worktree-notes
//
// Saves notes and their settings together, then — if sync is on — mirrors
// the notes to the worktree's cmux workspace description. The notes are
// committed FIRST: a cmux failure is reported in cmux_sync, never as a failed
// save, because the notes themselves are safe.
//
// A save carrying base_notes is merged with any edit made since the client
// loaded. Syncing in both directions is syncNotesLocked's job.
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

	// Lock on the registry path: the periodic cmux pass keys on it too.
	path := entry.Path
	unlock := s.notesLock(path)
	defer unlock()

	var stored notes.Notes
	saved := false
	for range notesSyncTries {
		prev, err := notes.Get(s.DB, path)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		text := req.Notes
		// A save from an older tab sends no base and overwrites. With one,
		// edits made elsewhere since the client loaded are merged in.
		if req.BaseNotes != nil && notes.Normalize(prev.Text) != notes.Normalize(*req.BaseNotes) {
			text = notes.Merge(req.BaseNotes, req.Notes, prev.Text, "other edit")
		}
		showOnHome := prev.ShowOnHome
		if req.ShowOnHome != nil {
			showOnHome = *req.ShowOnHome
		}
		// The base is only meaningful while sync is on; syncNotesLocked
		// decides push, pull or merge from it.
		var base *string
		baseWorkspace := ""
		if req.SyncCmux {
			base, baseWorkspace = prev.CmuxBase, prev.CmuxBaseWorkspace
		}
		n, ok, err := notes.CompareAndSet(s.DB, path, prev.Version, text, req.SyncCmux, showOnHome, base, baseWorkspace)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if ok {
			stored, saved = n, true
			break
		}
	}
	if !saved {
		writeError(w, http.StatusConflict, "notes changed while saving; try again")
		return
	}

	resp := setWorktreeNotesResponse{CmuxSync: cmuxSyncOff}
	if stored.SyncCmux {
		resp.CmuxSync, resp.CmuxError = s.syncNotesLocked(path, nil)
		// The sync may have pulled or merged cmux's text into the notes.
		if n, err := notes.Get(s.DB, path); err == nil {
			stored = n
		}
	}
	resp.worktreeNotesDTO = newWorktreeNotesDTO(stored)
	writeJSON(w, http.StatusOK, resp)
}
