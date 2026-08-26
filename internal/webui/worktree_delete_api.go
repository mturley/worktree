package webui

import (
	"encoding/json"
	"net/http"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/worktreedel"
)

type deleteWorktreeRequest struct {
	Path           string `json:"path"`
	DeleteBranch   bool   `json:"delete_branch"`
	ForceDirectory bool   `json:"force_directory"`
	ForceBranch    bool   `json:"force_branch"`
}

type deleteWorktreeResponse struct {
	OK         bool                `json:"ok"`
	NeedsForce worktreedel.StepKey `json:"needs_force"`
	Steps      []worktreedel.Step  `json:"steps"`
	Error      string              `json:"error,omitempty"`
}

// handleDeleteWorktree: POST /api/worktrees/delete
//
// needs_force comes back as 200 with a marker, never an error status: "git
// wants confirmation" and "the delete broke" are the one distinction the whole
// flow rests on, and an error status would collapse them. A hard failure is
// also 200 with ok:false, so the modal can render the partial step list rather
// than replacing it with an error page.
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
	cfg, err := config.Load()
	if err != nil {
		writeJSON(w, http.StatusOK, deleteWorktreeResponse{
			OK:    false,
			Steps: []worktreedel.Step{},
			Error: err.Error(),
		})
		return
	}

	res := worktreedel.Run(s.DB, cfg, worktreedel.Options{
		Path:           req.Path,
		DeleteBranch:   req.DeleteBranch,
		ForceDirectory: req.ForceDirectory,
		ForceBranch:    req.ForceBranch,
	}, nil)

	out := deleteWorktreeResponse{
		OK:         res.Err == nil && res.NeedsForce == "",
		NeedsForce: res.NeedsForce,
		Steps:      res.Steps,
	}
	if res.Err != nil {
		out.Error = res.Err.Error()
	}
	writeJSON(w, http.StatusOK, out)
}
