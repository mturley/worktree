package webui

import (
	"encoding/json"
	"net/http"
	"path/filepath"

	"github.com/mturley/worktree/internal/worktreedel"
)

type deleteWorktreeRequest struct {
	Path           string `json:"path"`
	DeleteBranch   bool   `json:"delete_branch"`
	ForceDirectory bool   `json:"force_directory"`
	ForceBranch    bool   `json:"force_branch"`
}

// handleDeleteWorktree: POST /api/worktrees/delete
//
// The delete runs as a background job: this route only validates the request
// and starts one, so a tab closed mid-delete cannot leave a worktree half
// removed with nobody watching. Progress, the force questions and the final
// outcome all arrive through /api/jobs and the `job` stream events.
func (s *Server) handleDeleteWorktree(w http.ResponseWriter, r *http.Request) {
	var req deleteWorktreeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	// The path is the target: a second request for the same worktree attaches
	// to the delete already running.
	s.startJob(w, jobKindDelete, "Delete worktree "+filepath.Base(req.Path), req.Path, req)
}

func (req deleteWorktreeRequest) options() worktreedel.Options {
	return worktreedel.Options{
		Path:           req.Path,
		DeleteBranch:   req.DeleteBranch,
		ForceDirectory: req.ForceDirectory,
		ForceBranch:    req.ForceBranch,
	}
}
