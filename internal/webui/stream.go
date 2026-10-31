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
	// Taken before the headers go out, so a kubeconfig change made as soon
	// as the client sees the stream open is still caught by the first tick.
	lastKube := s.kubeconfigFingerprint()
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

	// Listening ports, unless the stream opts out: the mini view keeps its
	// stream open for good and shows no ports, so it must not keep the
	// scanner running (see listeners.go).
	var ports <-chan []byte
	if r.URL.Query().Get("listeners") != "0" {
		ch, unsubscribe := s.listenersHub().subscribe()
		defer unsubscribe()
		ports = ch
	}

	var last string
	s.DB.QueryRow(`SELECT COALESCE(MAX(ts),'') FROM watcher_events`).Scan(&last)
	lastTasks := s.seedTasksVersion()

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
		case b := <-ports:
			fmt.Fprintf(w, "event: listeners_changed\ndata: %s\n\n", b)
			flusher.Flush()
		case <-ticker.C:
			var cur string
			s.DB.QueryRow(`SELECT COALESCE(MAX(ts),'') FROM watcher_events`).Scan(&cur)
			if cur != last {
				last = cur
				fmt.Fprintf(w, "event: events_new\ndata: {}\n\n")
			}
			if s.tasksVersionAdvanced(&lastTasks) {
				fmt.Fprintf(w, "event: tasks_changed\ndata: {}\n\n")
			}
			// A worktree's kubeconfig changed: the detail page refetches its
			// worktree-info for the Kubeconfig section.
			if kube := s.kubeconfigFingerprint(); kube != lastKube {
				lastKube = kube
				fmt.Fprintf(w, "event: kubeconfig_changed\ndata: {}\n\n")
			}
			fmt.Fprintf(w, "event: heartbeat\ndata: {}\n\n")
			flusher.Flush()
		}
	}
}
