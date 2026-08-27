package webui

import (
	"encoding/json"
	"net/http"

	"github.com/mturley/watcher"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/resourceurl"
)

type addResourceRequest struct {
	Path    string `json:"path"`
	URL     string `json:"url"`
	Related bool   `json:"related"`
}

// handleAddResource infers the resource type+id from the given URL, creates
// the subscription, best-effort inline-enriches it via pollOne so the UI
// doesn't have to wait for the next background poll, and returns the DTO.
func (s *Server) handleAddResource(w http.ResponseWriter, r *http.Request) {
	var req addResourceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Path == "" || req.URL == "" {
		writeError(w, http.StatusBadRequest, "missing path or url")
		return
	}
	resType, id, ok := resourceurl.Infer(req.URL)
	if !ok {
		writeError(w, http.StatusBadRequest, "unrecognized resource URL")
		return
	}
	if err := resources.Add(s.DB, req.Path, resources.Resource{Type: resType, ID: id, URL: req.URL, Related: req.Related}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Inline-enrich (best effort): populate resource_state before responding.
	s.pollOne(watcher.Resource{Type: resType, ID: id, URL: req.URL})

	// Build the DTO for the newly-added resource (mirrors handleWorktreeResources).
	dto := resourceDTO{Type: resType, ID: id, URL: req.URL, Primary: !req.Related}
	s.enrichResourceDTO(&dto)
	writeJSON(w, http.StatusOK, dto)
}

type removeResourceRequest struct {
	Path string `json:"path"`
	Type string `json:"type"`
	ID   string `json:"id"`
}

// handleRemoveResource hard-deletes a worktree resource subscription.
func (s *Server) handleRemoveResource(w http.ResponseWriter, r *http.Request) {
	var req removeResourceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Path == "" || req.Type == "" || req.ID == "" {
		writeError(w, http.StatusBadRequest, "missing path, type, or id")
		return
	}
	if err := resources.Remove(s.DB, req.Path, req.Type, req.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleSetResourcePrimary reclassifies a tracked resource between focus
// (primary) and related, in place.
//
// Previously the flag could only be set when a resource was added, so
// changing your mind meant removing and re-adding it — losing its custom
// metadata along the way. The UI fires this directly on toggle with no
// confirmation step, so it must be cheap and idempotent.
func (s *Server) handleSetResourcePrimary(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path    string `json:"path"`
		Type    string `json:"type"`
		ID      string `json:"id"`
		Primary bool   `json:"primary"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if body.Path == "" || body.Type == "" || body.ID == "" {
		writeError(w, http.StatusBadRequest, "missing path, type, or id")
		return
	}
	if err := resources.SetPrimary(s.DB, body.Path, body.Type, body.ID, body.Primary); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
