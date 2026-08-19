package webui

import (
	"encoding/json"
	"net/http"

	"github.com/mturley/worktree/internal/resources"
)

type resourceMetaRequest struct {
	Type        string `json:"type"`
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// handleSetResourceMeta persists a user-supplied custom name/description for a
// resource. Metadata is per-resource, so no worktree path is required.
func (s *Server) handleSetResourceMeta(w http.ResponseWriter, r *http.Request) {
	var req resourceMetaRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Type == "" || req.ID == "" {
		writeError(w, http.StatusBadRequest, "missing type or id")
		return
	}
	if err := resources.SetMeta(s.DB, req.Type, req.ID, req.Name, req.Description); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
