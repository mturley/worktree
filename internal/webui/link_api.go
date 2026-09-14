package webui

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/mturley/worktree/internal/linkmeta"
	"github.com/mturley/worktree/internal/resourceurl"
)

// linkResolver returns the configured resolver, or a default one. A seam for
// tests, mirroring imageProxyTransport.
func (s *Server) linkResolver() *linkmeta.Resolver {
	if s.LinkResolver != nil {
		return s.LinkResolver
	}
	return &linkmeta.Resolver{}
}

// resolveAndStoreLink fetches a link's metadata and caches it. Best effort:
// a resolution failure is recorded in the cached blob, never returned as an
// API error, because an unreachable page is still a resource worth following.
func (s *Server) resolveAndStoreLink(ctx context.Context, id string) {
	m := s.linkResolver().Resolve(ctx, id)
	if err := s.saveLinkMeta(id, m); err != nil && s.Logger != nil {
		s.Logger.Printf("saveLinkMeta(%s): %v", id, err)
	}
}

type resolveRequest struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// handleResourceResolve re-resolves a link on demand. This is the whole
// refresh story for links: they are never polled, so the only way metadata
// becomes current again is someone asking.
func (s *Server) handleResourceResolve(w http.ResponseWriter, r *http.Request) {
	var req resolveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Type != "link" {
		writeError(w, http.StatusBadRequest, "only link resources can be resolved")
		return
	}
	if req.ID == "" {
		writeError(w, http.StatusBadRequest, "missing id")
		return
	}
	s.resolveAndStoreLink(r.Context(), req.ID)
	dto := resourceDTO{Type: "link", ID: req.ID, URL: req.ID}
	s.enrichResourceDTO(&dto)
	writeJSON(w, http.StatusOK, dto)
}

// handleResourceType classifies a URL. It exists so the add-resource modal
// can ask the one detector what a URL is, instead of re-implementing the
// patterns in TypeScript — which is the duplication internal/resourceurl was
// created to end. Read-only: no DB write, no outbound request.
func (s *Server) handleResourceType(w http.ResponseWriter, r *http.Request) {
	resType, id, ok := resourceurl.InferAny(r.URL.Query().Get("url"))
	if !ok {
		writeJSON(w, http.StatusOK, map[string]string{"type": "", "id": ""})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"type": resType, "id": id})
}
