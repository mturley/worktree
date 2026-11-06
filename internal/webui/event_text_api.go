package webui

import (
	"net/http"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
)

// EventTextChange returns the before/after text stored with an event, or
// (nil, nil) when the event has none.
func (s *Server) EventTextChange(id string) (*watcher.TextChange, error) {
	return watcherdb.EventTextChange(s.DB, id)
}

// handleEventTextChange serves GET /api/event-text-change?id=<event id>: the
// full old and new text behind a description-changed event, which the UI
// diffs. Fetched on demand so timeline payloads stay small.
func (s *Server) handleEventTextChange(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	tc, err := s.EventTextChange(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if tc == nil {
		writeError(w, http.StatusNotFound, "no text change stored for this event")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"old_text": tc.Old, "new_text": tc.New})
}
