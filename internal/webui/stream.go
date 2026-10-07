package webui

import (
	"encoding/json"
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

	// A tab that names itself can be chosen to show a browser notification.
	// Its initial route and visibility ride on the URL, because a presence
	// POST racing this registration would be refused as an unknown tab.
	var notifications <-chan notificationMsg
	if tab := r.URL.Query().Get("tab"); tab != "" {
		sess, _ := currentSession(r)
		send, done := s.tabRegistry().register(tab, sess.Handle, r.URL.Query().Get("route"), r.URL.Query().Get("visible") == "1")
		defer done()
		notifications = send
	}

	// Every tab hears where cmux focus went; the tab decides whether to
	// follow it (ui/src/components/CmuxFollower.tsx).
	focus, unsubscribe := s.focusHub().subscribe()
	defer unsubscribe()

	var last string
	s.DB.QueryRow(`SELECT COALESCE(MAX(ts),'') FROM watcher_events`).Scan(&last)

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-notifications:
			b, _ := json.Marshal(msg)
			fmt.Fprintf(w, "event: notification\ndata: %s\n\n", b)
			flusher.Flush()
		case msg := <-focus:
			b, _ := json.Marshal(msg)
			fmt.Fprintf(w, "event: cmux_focus\ndata: %s\n\n", b)
			flusher.Flush()
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
