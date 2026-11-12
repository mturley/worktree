package webui

import (
	"fmt"
	"net/http"
)

// EventByID returns one watcher event as the global timeline would serve it
// (task events are not in watcher_events; their rows link to the task instead),
// or nil if there is none.
func (s *Server) EventByID(id string) (*TimelineEvent, error) {
	rows, err := s.DB.Query(`
SELECT e.id, e.ts, COALESCE(e.external_ts,''), e.source, e.type,
       COALESCE(e.title,''), COALESCE(e.body,''), COALESCE(e.author,''), COALESCE(e.author_type,''), COALESCE(e.author_id,''), e.out_of_date,
       er.resource_type, er.resource_id, COALESCE(er.resource_url,'')
FROM watcher_events e
JOIN watcher_event_resources er ON er.event_id = e.id
WHERE e.id = ?
LIMIT 1`, id)
	if err != nil {
		return nil, fmt.Errorf("query event: %w", err)
	}
	defer rows.Close()
	out, err := s.collectTimelineRows(rows, 1, nil)
	if err != nil {
		return nil, fmt.Errorf("read event: %w", err)
	}
	if len(out) == 0 {
		return nil, nil
	}
	return &out[0], nil
}

// handleEvent: GET /api/event?id=..., for a link that opens one event's details
// (see the mini view's "Open in full UI").
func (s *Server) handleEvent(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	ev, err := s.EventByID(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if ev == nil {
		writeError(w, http.StatusNotFound, "no such event")
		return
	}
	writeJSON(w, http.StatusOK, ev)
}
