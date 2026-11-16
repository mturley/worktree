package webui

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/mturley/worktree/internal/jobs"
	"github.com/mturley/worktree/internal/notes"
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

	// Background jobs. The subscription is taken before the snapshot goes
	// out, under the manager's lock, so no change can fall between the two.
	jobSnapshot, jobChanges, unsubscribeJobs := s.jobs().Subscribe()
	defer unsubscribeJobs()

	var last string
	s.DB.QueryRow(`SELECT COALESCE(MAX(ts),'') FROM watcher_events`).Scan(&last)
	lastTasks := s.seedTasksVersion()
	lastNotes := s.seedNotesFingerprint()

	// One now, so the sections' "checked … ago" needn't wait a tick.
	s.writeHeartbeat(w, ports != nil)
	// Then every visible job, so a tab that was asleep while one ran shows
	// it the moment it reconnects, without waiting for a change.
	if jobSnapshot == nil {
		jobSnapshot = []jobs.Job{}
	}
	jobsJSON, _ := json.Marshal(jobsResponse{Jobs: jobSnapshot})
	fmt.Fprintf(w, "event: jobs\ndata: %s\n\n", jobsJSON)
	flusher.Flush()

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
		case job, ok := <-jobChanges:
			if !ok {
				// This stream fell too far behind the job changes and the
				// manager dropped it. Returning closes the stream, and the
				// tab reconnects onto a fresh snapshot — the only way back
				// to a state it can trust.
				return
			}
			b, _ := json.Marshal(job)
			fmt.Fprintf(w, "event: job\ndata: %s\n\n", b)
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
			// Notes written by another process or the cmux pass: open tabs
			// refetch them.
			if s.notesFingerprintChanged(&lastNotes) {
				fmt.Fprintf(w, "event: notes_changed\ndata: {}\n\n")
			}
			// A worktree's kubeconfig changed: the detail page refetches its
			// worktree-info for the Kubeconfig section.
			if kube := s.kubeconfigFingerprint(); kube != lastKube {
				lastKube = kube
				fmt.Fprintf(w, "event: kubeconfig_changed\ndata: {}\n\n")
			}
			s.writeHeartbeat(w, ports != nil)
			flusher.Flush()
		}
	}
}

// heartbeatMsg is the heartbeat's payload: when this server last checked
// what the Environment tab's sections show, for their "checked … ago".
// Every tick re-checks the kubeconfigs (the fingerprint above), so its time
// is the tick's. The ports time is the last successful scan, and is left
// out for a stream that doesn't take ports or while scanning is off.
type heartbeatMsg struct {
	ListenersCheckedAt  string `json:"listeners_checked_at,omitempty"`
	KubeconfigCheckedAt string `json:"kubeconfig_checked_at"`
}

func (s *Server) writeHeartbeat(w io.Writer, withPorts bool) {
	msg := heartbeatMsg{KubeconfigCheckedAt: time.Now().UTC().Format(time.RFC3339)}
	if withPorts && !s.portScanDisabled.Load() {
		if at := s.listenersHub().checkedAt(); !at.IsZero() {
			msg.ListenersCheckedAt = at.UTC().Format(time.RFC3339)
		}
	}
	b, _ := json.Marshal(msg)
	fmt.Fprintf(w, "event: heartbeat\ndata: %s\n\n", b)
}

// seedNotesFingerprint is the notes fingerprint a new stream starts from, so
// it reports only changes made after it connected. Empty when unreadable.
func (s *Server) seedNotesFingerprint() string {
	f, err := notes.Fingerprint(s.DB)
	if err != nil {
		return ""
	}
	return f
}

// notesFingerprintChanged reports whether the notes fingerprint has moved
// past *last, recording the new value. A read error reports no change.
func (s *Server) notesFingerprintChanged(last *string) bool {
	f, err := notes.Fingerprint(s.DB)
	if err != nil || f == *last {
		return false
	}
	*last = f
	return true
}
