package webui

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	wconfig "github.com/mturley/watcher/config"
	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	wslack "github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/config"
)

// Credential test and replace for the Settings modal's Watcher Auth tab,
// plus the write-only UI password. A replace validates first and writes
// only on success — any failure, rejection or unreachable service alike,
// leaves the stored credential in place. Secrets travel only inward: no
// response ever contains one.

type credValidators struct {
	github      func(token string) error
	jira        func(host, email, token string) error
	slack       func(token, cookie string) error
	slackDomain func(token, cookie string) string
}

func (s *Server) validators() credValidators {
	if s.credCheck != nil {
		return *s.credCheck
	}
	return credValidators{
		github: func(t string) error { return wgithub.Validate(t) },
		jira:   wjira.Validate,
		slack:  func(t, c string) error { return wslack.Validate(t, c) },
		slackDomain: func(t, c string) string {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			d, err := wslack.New(t, c).TeamInfo(ctx)
			if err != nil {
				return ""
			}
			return d
		},
	}
}

type credResult struct {
	OK     bool   `json:"ok"`
	Kind   string `json:"kind"` // ok | auth | network | missing | unsaved
	Detail string `json:"detail"`
}

func classify(err error) credResult {
	switch {
	case err == nil:
		return credResult{OK: true, Kind: "ok"}
	case errors.Is(err, wgithub.ErrAuth), errors.Is(err, wjira.ErrAuth), errors.Is(err, wslack.ErrAuth):
		return credResult{Kind: "auth", Detail: err.Error()}
	default:
		return credResult{Kind: "network", Detail: err.Error()}
	}
}

var missing = credResult{Kind: "missing", Detail: "not configured"}

type credRequest struct {
	Token  string `json:"token"`
	Cookie string `json:"cookie"`
	Host   string `json:"host"`
	Email  string `json:"email"`
}

func decodeCred(w http.ResponseWriter, r *http.Request) (credRequest, error) {
	var req credRequest
	if r.ContentLength == 0 {
		return req, nil
	}
	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req)
	req.Token = strings.TrimSpace(req.Token)
	req.Cookie = strings.TrimSpace(req.Cookie)
	req.Host = strings.TrimRight(strings.TrimSpace(req.Host), "/")
	req.Email = strings.TrimSpace(req.Email)
	return req, err
}

// handleCredTest: POST /api/settings/credentials/{service}/test
//
// A token or cookie in the body is a candidate the modal holds unsaved: it
// is validated in place of the stored value and never written (Save sends
// it through handleCredReplace). Without one, the stored value is tested.
func (s *Server) handleCredTest(w http.ResponseWriter, r *http.Request) {
	req, err := decodeCred(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	cfg, err := s.loadWatcherAuth()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reading auth.yaml: "+err.Error())
		return
	}
	v := s.validators()
	switch svc := r.PathValue("service"); svc {
	case "github":
		if req.Token != "" {
			writeJSON(w, http.StatusOK, classify(v.github(req.Token)))
			return
		}
		g := cfg.Services.GitHub
		if g == nil || g.Token == "" {
			writeJSON(w, http.StatusOK, missing)
			return
		}
		writeJSON(w, http.StatusOK, classify(v.github(g.Token)))
	case "jira":
		j := cfg.Services.Jira
		if req.Token != "" {
			// The user's new token, so the form's (possibly unsaved) host is
			// the one it is meant for.
			host, email := req.Host, req.Email
			if j != nil {
				if host == "" {
					host = strings.TrimRight(strings.TrimSpace(j.Host), "/")
				}
				if email == "" {
					email = j.Email
				}
			}
			if host == "" || email == "" {
				writeError(w, http.StatusBadRequest, "host and email are required")
				return
			}
			if !validJiraHost(host) {
				writeError(w, http.StatusBadRequest, "Jira host must be an http(s) URL")
				return
			}
			writeJSON(w, http.StatusOK, classify(v.jira(host, email, req.Token)))
			return
		}
		if j == nil || j.Token == "" {
			writeJSON(w, http.StatusOK, missing)
			return
		}
		host, email := j.Host, j.Email
		// A host override is honoured only when it is the stored host: the
		// stored token must never be sent to a host the user hasn't saved.
		if req.Host != "" && !strings.EqualFold(req.Host, strings.TrimRight(strings.TrimSpace(j.Host), "/")) {
			writeJSON(w, http.StatusOK, credResult{Kind: "unsaved",
				Detail: "Replace the token to test it with the new host."})
			return
		}
		if req.Email != "" {
			email = req.Email
		}
		writeJSON(w, http.StatusOK, classify(v.jira(host, email, j.Token)))
	case "slack":
		// Validated as a pair: a candidate half is joined with the stored other.
		tok, ck := req.Token, req.Cookie
		if sl := cfg.Services.Slack; sl != nil {
			if tok == "" {
				tok = sl.Token
			}
			if ck == "" {
				ck = sl.Cookie
			}
		}
		if tok == "" || ck == "" {
			writeJSON(w, http.StatusOK, missing)
			return
		}
		writeJSON(w, http.StatusOK, classify(v.slack(tok, ck)))
	default:
		writeError(w, http.StatusNotFound, "unknown service "+svc)
	}
}

// handleCredReplace: PUT /api/settings/credentials/{service}
//
// Order matters: read what is needed, validate (a network call that can take
// many seconds) WITHOUT holding settingsMu, then take the lock, reload
// auth.yaml and apply the change to that fresh copy — so a concurrent save
// made during validation is never overwritten with a stale copy.
func (s *Server) handleCredReplace(w http.ResponseWriter, r *http.Request) {
	req, err := decodeCred(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	v := s.validators()
	var verr error
	var apply func(cfg *wconfig.Config)
	// check runs under the lock against the freshly reloaded copy.
	var check func(cfg *wconfig.Config) bool
	switch svc := r.PathValue("service"); svc {
	case "github":
		if req.Token == "" {
			writeError(w, http.StatusBadRequest, "token is required")
			return
		}
		verr = v.github(req.Token)
		apply = func(cfg *wconfig.Config) { cfg.Services.GitHub = &wconfig.GitHubConfig{Token: req.Token} }
	case "jira":
		if req.Token == "" || req.Host == "" || req.Email == "" {
			writeError(w, http.StatusBadRequest, "token, host and email are required")
			return
		}
		if !validJiraHost(req.Host) {
			writeError(w, http.StatusBadRequest, "Jira host must be an http(s) URL")
			return
		}
		verr = v.jira(req.Host, req.Email, req.Token)
		apply = func(cfg *wconfig.Config) {
			cfg.Services.Jira = &wconfig.JiraConfig{Host: req.Host, Email: req.Email, Token: req.Token}
		}
	case "slack":
		if req.Token == "" && req.Cookie == "" {
			writeError(w, http.StatusBadRequest, "token or cookie is required")
			return
		}
		// Read-only load for the stored other half; no lock held.
		stored, err := s.loadWatcherAuth()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "reading auth.yaml: "+err.Error())
			return
		}
		var storedTok, storedCk, storedDomain string
		if sl := stored.Services.Slack; sl != nil {
			storedTok, storedCk, storedDomain = sl.Token, sl.Cookie, sl.WorkspaceDomain
		}
		tok, ck := req.Token, req.Cookie
		if tok == "" {
			tok = storedTok
		}
		if ck == "" {
			ck = storedCk
		}
		if tok == "" || ck == "" {
			writeJSON(w, http.StatusUnprocessableEntity, credResult{Kind: "missing",
				Detail: "Slack needs both a token and a cookie; the other one isn't stored yet"})
			return
		}
		verr = v.slack(tok, ck)
		domain := ""
		if verr == nil {
			domain = v.slackDomain(tok, ck)
			if domain == "" {
				domain = storedDomain // best-effort; keep the old one
			}
		}
		check = func(cfg *wconfig.Config) bool {
			// The half we did not receive must be the one we validated.
			var t, c string
			if sl := cfg.Services.Slack; sl != nil {
				t, c = sl.Token, sl.Cookie
			}
			return (req.Token != "" || t == storedTok) && (req.Cookie != "" || c == storedCk)
		}
		apply = func(cfg *wconfig.Config) {
			cfg.Services.Slack = &wconfig.SlackConfig{Token: tok, Cookie: ck, WorkspaceDomain: domain}
		}
	default:
		writeError(w, http.StatusNotFound, "unknown service "+svc)
		return
	}
	if verr != nil {
		writeJSON(w, http.StatusUnprocessableEntity, classify(verr))
		return
	}

	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	cfg, err := s.loadWatcherAuth()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reading auth.yaml: "+err.Error())
		return
	}
	if check != nil && !check(cfg) {
		writeError(w, http.StatusConflict, "auth.yaml changed during validation; try again")
		return
	}
	apply(cfg)
	if err := cfg.Save(s.watcherAuthPath()); err != nil {
		writeError(w, http.StatusInternalServerError, "saving auth.yaml: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, credResult{OK: true, Kind: "ok"})
}

// handlePasswordReplace: PUT /api/settings/password. Writes the file, then
// swaps the running server's password; existing sessions stay valid.
func (s *Server) handlePasswordReplace(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	pw := req.Password // stored verbatim: login compares the raw input
	if strings.TrimSpace(pw) == "" {
		writeError(w, http.StatusBadRequest, "password can't be empty")
		return
	}
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	if err := config.SetPassword(s.configPath(), pw); err != nil {
		writeError(w, http.StatusInternalServerError, "saving config: "+err.Error())
		return
	}
	if s.Security != nil {
		s.Security.SetPassword(pw)
	}
	s.logger().Printf("settings: UI password replaced")
	w.WriteHeader(http.StatusNoContent)
}
