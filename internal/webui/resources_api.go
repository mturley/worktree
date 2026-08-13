package webui

import (
	"net/http"

	"github.com/mturley/worktree/internal/resources"
)

type resourceDTO struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	URL     string `json:"url"`
	Primary bool   `json:"primary"`
}

func (s *Server) handleWorktreeResources(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	rs, err := resources.Load(s.DB, path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]resourceDTO, 0, len(rs))
	for _, res := range rs {
		out = append(out, resourceDTO{Type: res.Type, ID: res.ID, URL: res.URL, Primary: !res.Related})
	}
	writeJSON(w, http.StatusOK, out)
}
