package webui

import (
	"fmt"
	"net/http"
	"time"
)

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher.Flush()

	var last string
	s.DB.QueryRow(`SELECT COALESCE(MAX(ts),'') FROM watcher_events`).Scan(&last)

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			var cur string
			s.DB.QueryRow(`SELECT COALESCE(MAX(ts),'') FROM watcher_events`).Scan(&cur)
			if cur != last {
				last = cur
				fmt.Fprintf(w, "event: events_new\ndata: {}\n\n")
			}
			fmt.Fprintf(w, "event: heartbeat\ndata: {}\n\n")
			flusher.Flush()
		}
	}
}
