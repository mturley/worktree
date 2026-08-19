package webui

import (
	"encoding/json"
	"net/http"
)

// handleThreadEvents implements GET /api/thread-events?channel=&thread_ts=:
// it subscribes to the SlackPoller for the requested (channel, threadTS) and
// streams each resulting update to the client as a Server-Sent Event, using
// the same enriched ThreadResponse shape as GET /api/thread (via
// buildThreadResponse) so the two stay consistent. The subscription is torn
// down when the client disconnects.
func (s *Server) handleThreadEvents(w http.ResponseWriter, r *http.Request) {
	if s.SlackClient == nil || s.SlackPoller == nil {
		s.slackUnavailable(w)
		return
	}
	ch := r.URL.Query().Get("channel")
	ts := r.URL.Query().Get("thread_ts")
	if ch == "" || ts == "" {
		http.Error(w, "channel and thread_ts required", http.StatusBadRequest)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	updates, unsubscribe := s.SlackPoller.Subscribe(ch, ts)
	defer unsubscribe()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case u, ok := <-updates:
			if !ok {
				return
			}
			resp, err := s.buildThreadResponse(ctx, ch, ts, u.Thread)
			if err != nil {
				if s.Logger != nil {
					s.Logger.Printf("sse: building thread response for channel=%s thread_ts=%s: %v", ch, ts, err)
				}
				continue
			}
			payload, err := json.Marshal(resp)
			if err != nil {
				continue
			}
			if _, err := w.Write([]byte("data: ")); err != nil {
				return
			}
			if _, err := w.Write(payload); err != nil {
				return
			}
			if _, err := w.Write([]byte("\n\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
