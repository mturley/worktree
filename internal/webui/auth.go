package webui

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/mturley/worktree/internal/uisession"
)

const (
	sessionCookieName = "worktree_session"
	// loginRequiredHeader marks a 401 as "log in to worktree". Some Slack
	// handlers also return 401, for Slack's own credentials, and the UI
	// must not confuse the two.
	loginRequiredHeader = "X-Worktree-Login-Required"
)

// loginFailDelay slows every wrong-password answer. A package var so tests
// need not wait. There is no lockout: on a single-user tool a lockout only
// locks out the user.
var loginFailDelay = 750 * time.Millisecond

type sessionContextKey struct{}

func currentSession(r *http.Request) (uisession.Session, bool) {
	sess, ok := r.Context().Value(sessionContextKey{}).(uisession.Session)
	return sess, ok
}

// requireSession refuses every /api/ request without a live session, except
// the login call. It checks the path prefix, not a list of routes, so a
// route added later is covered without anyone remembering to list it.
func (s *Server) requireSession(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") ||
			(r.Method == http.MethodPost && r.URL.Path == "/api/login") {
			h.ServeHTTP(w, r)
			return
		}
		sess, ok := s.sessionFromRequest(r)
		if !ok {
			w.Header().Set(loginRequiredHeader, "1")
			writeError(w, http.StatusUnauthorized, "login required")
			return
		}
		h.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), sessionContextKey{}, sess)))
	})
}

func (s *Server) sessionFromRequest(r *http.Request) (uisession.Session, bool) {
	c, err := r.Cookie(sessionCookieName)
	if err != nil {
		return uisession.Session{}, false
	}
	sess, ok, err := s.Security.Sessions.Lookup(c.Value)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Printf("session lookup: %v", err)
		}
		return uisession.Session{}, false
	}
	if !ok {
		return uisession.Session{}, false
	}
	if _, err := s.Security.Sessions.Touch(sess); err != nil && s.Logger != nil {
		s.Logger.Printf("session touch: %v", err)
	}
	return sess, true
}

// passwordMatches compares in constant time. Both sides are hashed first:
// subtle.ConstantTimeCompare returns early when lengths differ, which would
// reveal the password's length.
func passwordMatches(got, want string) bool {
	if want == "" {
		return false
	}
	g, w := sha256.Sum256([]byte(got)), sha256.Sum256([]byte(want))
	return subtle.ConstantTimeCompare(g[:], w[:]) == 1
}

type sessionDTO struct {
	Handle     string `json:"handle"`
	Label      string `json:"label"`
	CreatedAt  string `json:"created_at"`
	LastSeenAt string `json:"last_seen_at"`
	Current    bool   `json:"current"`
}

func tosessionDTO(sess uisession.Session, current bool) sessionDTO {
	return sessionDTO{
		Handle:     sess.Handle,
		Label:      sess.Label,
		CreatedAt:  sess.CreatedAt.Format(time.RFC3339),
		LastSeenAt: sess.LastSeenAt.Format(time.RFC3339),
		Current:    current,
	}
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		// Per request, because one server has both listeners. A Secure
		// cookie set over plain HTTP would be discarded by the browser.
		Secure: r.TLS != nil,
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if s.Security == nil {
		writeError(w, http.StatusServiceUnavailable, "authentication is not configured")
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !passwordMatches(req.Password, s.Security.Password) {
		time.Sleep(loginFailDelay)
		writeError(w, http.StatusUnauthorized, "incorrect password")
		return
	}
	if _, err := s.Security.Sessions.DeleteExpired(); err != nil && s.Logger != nil {
		s.Logger.Printf("deleting expired sessions: %v", err)
	}
	token, sess, err := s.Security.Sessions.Create(uisession.Label(r.UserAgent()))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not create a session")
		return
	}
	setSessionCookie(w, r, token, int(uisession.Lifetime/time.Second))
	writeJSON(w, http.StatusOK, tosessionDTO(sess, true))
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	sess, ok := currentSession(r)
	if s.Security == nil || !ok {
		writeError(w, http.StatusServiceUnavailable, "authentication is not configured")
		return
	}
	if _, err := s.Security.Sessions.Revoke(sess.Handle); err != nil {
		writeError(w, http.StatusInternalServerError, "could not log out")
		return
	}
	setSessionCookie(w, r, "", -1)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	sess, ok := currentSession(r)
	if s.Security == nil || !ok {
		writeError(w, http.StatusServiceUnavailable, "authentication is not configured")
		return
	}
	writeJSON(w, http.StatusOK, tosessionDTO(sess, true))
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	cur, ok := currentSession(r)
	if s.Security == nil || !ok {
		writeError(w, http.StatusServiceUnavailable, "authentication is not configured")
		return
	}
	list, err := s.Security.Sessions.List()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list sessions")
		return
	}
	out := make([]sessionDTO, 0, len(list))
	for _, sess := range list {
		out = append(out, tosessionDTO(sess, sess.Handle == cur.Handle))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleRevokeSession(w http.ResponseWriter, r *http.Request) {
	cur, ok := currentSession(r)
	if s.Security == nil || !ok {
		writeError(w, http.StatusServiceUnavailable, "authentication is not configured")
		return
	}
	var req struct {
		Handle string `json:"handle"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil || req.Handle == "" {
		writeError(w, http.StatusBadRequest, "missing handle")
		return
	}
	found, err := s.Security.Sessions.Revoke(req.Handle)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not revoke the session")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "no such session")
		return
	}
	if req.Handle == cur.Handle {
		setSessionCookie(w, r, "", -1)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
