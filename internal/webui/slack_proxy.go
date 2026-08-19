package webui

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/mturley/watcher/slack"
)

// noFollowRedirects is a CheckRedirect policy shared by every client the
// image proxy uses for its outbound fetch. The allowlist check in
// handleImageProxy only validates the host of the initially requested URL;
// if the client followed redirects, an allowed host could 3xx-redirect to
// an arbitrary internal/external host and bypass the allowlist entirely
// (classic redirect-based SSRF). Returning http.ErrUseLastResponse tells
// net/http to hand back the 3xx response as-is instead of chasing it.
// This is applied unconditionally in handleImageProxy (not left to whatever
// client happens to be configured) so the protection can't be silently
// dropped by swapping the transport, e.g. in tests.
func noFollowRedirects(req *http.Request, via []*http.Request) error {
	return http.ErrUseLastResponse
}

// markReadRequest is the JSON body expected by POST /api/thread/mark-read.
type markReadRequest struct {
	Channel  string `json:"channel"`
	ThreadTS string `json:"thread_ts"`
	TS       string `json:"ts"`
}

// handleMarkRead implements POST /api/thread/mark-read: it marks a thread
// read up through the given ts via the Slack client.
func (s *Server) handleMarkRead(w http.ResponseWriter, r *http.Request) {
	if s.SlackClient == nil {
		s.slackUnavailable(w)
		return
	}
	var req markReadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if req.Channel == "" || req.ThreadTS == "" || req.TS == "" {
		http.Error(w, "channel, thread_ts, and ts required", http.StatusBadRequest)
		return
	}

	err := s.SlackClient.MarkRead(r.Context(), req.Channel, req.ThreadTS, req.TS)
	if errors.Is(err, slack.ErrAuth) {
		http.Error(w, "auth", http.StatusUnauthorized)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// handleMarkUnread implements POST /api/thread/mark-unread: it marks a
// thread unread as of the given ts via the Slack client.
func (s *Server) handleMarkUnread(w http.ResponseWriter, r *http.Request) {
	if s.SlackClient == nil {
		s.slackUnavailable(w)
		return
	}
	var req markReadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if req.Channel == "" || req.ThreadTS == "" || req.TS == "" {
		http.Error(w, "channel, thread_ts, and ts required", http.StatusBadRequest)
		return
	}

	err := s.SlackClient.MarkUnread(r.Context(), req.Channel, req.ThreadTS, req.TS)
	if errors.Is(err, slack.ErrAuth) {
		http.Error(w, "auth", http.StatusUnauthorized)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// replyRequest is the JSON body expected by POST /api/thread/reply.
type replyRequest struct {
	Channel  string `json:"channel"`
	ThreadTS string `json:"thread_ts"`
	Text     string `json:"text"`
}

// handleReply implements POST /api/thread/reply: it posts a reply to a
// thread via the Slack client and marks the thread read up through the new
// message on success. There is no send-allowlist — replies to any channel
// are permitted.
func (s *Server) handleReply(w http.ResponseWriter, r *http.Request) {
	if s.SlackClient == nil {
		s.slackUnavailable(w)
		return
	}
	var req replyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	text := strings.TrimSpace(req.Text)
	if req.Channel == "" || req.ThreadTS == "" || text == "" {
		http.Error(w, "channel, thread_ts, and text required", http.StatusBadRequest)
		return
	}

	msg, err := s.SlackClient.PostReply(r.Context(), req.Channel, req.ThreadTS, text)
	if errors.Is(err, slack.ErrAuth) {
		http.Error(w, "auth", http.StatusUnauthorized)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	if err := s.SlackClient.MarkRead(r.Context(), req.Channel, req.ThreadTS, msg.TS); err != nil && s.Logger != nil {
		s.Logger.Printf("reply: mark-read after send failed: %v", err)
	}

	writeJSON(w, http.StatusOK, MessageView{msg})
}

// reactRequest is the JSON body expected by POST /api/thread/react.
type reactRequest struct {
	Channel string `json:"channel"`
	TS      string `json:"ts"`
	Name    string `json:"name"`
	Add     bool   `json:"add"`
}

// handleReact implements POST /api/thread/react: it toggles the current
// user's reaction on a message via reactions.add/remove. There is no
// send-allowlist — reactions on any channel are permitted.
func (s *Server) handleReact(w http.ResponseWriter, r *http.Request) {
	if s.SlackClient == nil {
		s.slackUnavailable(w)
		return
	}
	var req reactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if req.Channel == "" || req.TS == "" || req.Name == "" {
		http.Error(w, "channel, ts, and name required", http.StatusBadRequest)
		return
	}

	var err error
	if req.Add {
		err = s.SlackClient.AddReaction(r.Context(), req.Channel, req.TS, req.Name)
	} else {
		err = s.SlackClient.RemoveReaction(r.Context(), req.Channel, req.TS, req.Name)
	}
	if errors.Is(err, slack.ErrAuth) {
		http.Error(w, "auth", http.StatusUnauthorized)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// handleImageProxy returns a handler that fetches the image at the ?url=
// query param and streams it back with its Content-Type. To prevent SSRF,
// the URL's host MUST exactly match allowedHost; any other host is rejected
// with 400 before any outbound request is made. When forwardCookie is true
// (the files.slack.com proxy), the stored d= session cookie is attached so
// authenticated file downloads succeed.
func (s *Server) handleImageProxy(allowedHost string, forwardCookie bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := r.URL.Query().Get("url")
		if raw == "" {
			http.Error(w, "url required", http.StatusBadRequest)
			return
		}
		u, err := url.Parse(raw)
		if err != nil {
			http.Error(w, "invalid url", http.StatusBadRequest)
			return
		}
		if u.Scheme != "https" {
			http.Error(w, "url scheme not allowed", http.StatusBadRequest)
			return
		}
		if u.Host != allowedHost {
			http.Error(w, "url host not allowed", http.StatusBadRequest)
			return
		}

		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		if forwardCookie && s.SlackCookie != "" {
			req.AddCookie(&http.Cookie{Name: "d", Value: s.SlackCookie})
		}

		transport := s.imageProxyTransport
		if transport == nil {
			transport = http.DefaultTransport
		}
		client := &http.Client{Transport: transport, CheckRedirect: noFollowRedirects}
		resp, err := client.Do(req)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		if ct := resp.Header.Get("Content-Type"); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.WriteHeader(resp.StatusCode)
		if _, err := io.Copy(w, resp.Body); err != nil && s.Logger != nil {
			s.Logger.Printf("image proxy: copying response body for %s: %v", u.String(), err)
		}
	}
}

// handleSlackAvatar / handleSlackEmoji / handleSlackFile are the concrete
// host-pinned image proxies. avatars/emoji do not forward the session
// cookie; files.slack.com requires the d= cookie for authenticated
// downloads.
func (s *Server) handleSlackAvatar(w http.ResponseWriter, r *http.Request) {
	s.handleImageProxy("avatars.slack-edge.com", false)(w, r)
}

func (s *Server) handleSlackEmoji(w http.ResponseWriter, r *http.Request) {
	s.handleImageProxy("emoji.slack-edge.com", false)(w, r)
}

func (s *Server) handleSlackFile(w http.ResponseWriter, r *http.Request) {
	s.handleImageProxy("files.slack.com", true)(w, r)
}
