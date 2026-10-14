package webui

import (
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"strings"

	wconfig "github.com/mturley/watcher/config"
)

// The watcher library's two files, as the Settings modal edits them.
// auth.yaml goes through the library's Load/Save (as `worktree setup`
// does), which keeps every key it knows — including consumers and the
// legacy jira_custom_fields, which the modal deliberately never shows.

type watcherAuthSettings struct {
	Jira struct {
		Host  string `json:"host"`
		Email string `json:"email"`
	} `json:"jira"`
	Slack struct {
		WorkspaceDomain string `json:"workspace_domain"`
	} `json:"slack"`
}

type watcherConfigSettings struct {
	Jira struct {
		BotUsernames []string          `json:"bot_usernames"`
		CustomFields map[string]string `json:"custom_fields"`
	} `json:"jira"`
}

func (s *Server) loadWatcherAuth() (*wconfig.Config, error) {
	return wconfig.Load(s.watcherAuthPath())
}

func (s *Server) readWatcherAuth() (watcherAuthSettings, settingsSecrets, error) {
	var out watcherAuthSettings
	var sec settingsSecrets
	cfg, err := s.loadWatcherAuth()
	if err != nil {
		return out, sec, err
	}
	if g := cfg.Services.GitHub; g != nil {
		sec.GitHubToken = g.Token != ""
	}
	if j := cfg.Services.Jira; j != nil {
		out.Jira.Host, out.Jira.Email = j.Host, j.Email
		sec.JiraToken = j.Token != ""
	}
	if sl := cfg.Services.Slack; sl != nil {
		out.Slack.WorkspaceDomain = sl.WorkspaceDomain
		sec.SlackToken, sec.SlackCookie = sl.Token != "", sl.Cookie != ""
	}
	return out, sec, nil
}

func (s *Server) readWatcherConfig() (watcherConfigSettings, error) {
	var out watcherConfigSettings
	out.Jira.BotUsernames = []string{}
	out.Jira.CustomFields = map[string]string{}
	cfg, err := wconfig.LoadConfig(s.watcherConfigPath())
	if err != nil {
		return out, err
	}
	if cfg.Jira != nil {
		out.Jira.BotUsernames = nonNil(cfg.Jira.BotUsernames)
		if cfg.Jira.CustomFields != nil {
			out.Jira.CustomFields = cfg.Jira.CustomFields
		}
	}
	return out, nil
}

// validJiraHost accepts "" (not configured) or an http(s) URL with a host.
func validJiraHost(h string) bool {
	if h == "" {
		return true
	}
	u, err := url.Parse(h)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != ""
}

// handleSettingsWatcherAuth: PUT /api/settings/watcher-auth — non-secret
// auth.yaml fields only. Tokens go through the credential endpoints.
func (s *Server) handleSettingsWatcherAuth(w http.ResponseWriter, r *http.Request) {
	var req watcherAuthSettings
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	host := strings.TrimRight(strings.TrimSpace(req.Jira.Host), "/")
	email := strings.TrimSpace(req.Jira.Email)
	domain := strings.TrimSpace(req.Slack.WorkspaceDomain)
	if !validJiraHost(host) {
		writeError(w, http.StatusBadRequest, "Jira host must be an http(s) URL, like https://yourorg.atlassian.net")
		return
	}

	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	cfg, err := s.loadWatcherAuth()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reading auth.yaml: "+err.Error())
		return
	}
	changed := false
	if cfg.Services.Jira == nil && (host != "" || email != "") {
		cfg.Services.Jira = &wconfig.JiraConfig{}
	}
	if j := cfg.Services.Jira; j != nil && (j.Host != host || j.Email != email) {
		j.Host, j.Email = host, email
		changed = true
	}
	if cfg.Services.Slack == nil && domain != "" {
		cfg.Services.Slack = &wconfig.SlackConfig{}
	}
	if sl := cfg.Services.Slack; sl != nil && sl.WorkspaceDomain != domain {
		sl.WorkspaceDomain = domain
		changed = true
	}
	if changed {
		if err := cfg.Save(s.watcherAuthPath()); err != nil {
			writeError(w, http.StatusInternalServerError, "saving auth.yaml: "+err.Error())
			return
		}
	}
	s.writeSettings(w)
}

// handleSettingsWatcherConfig: PUT /api/settings/watcher-config
func (s *Server) handleSettingsWatcherConfig(w http.ResponseWriter, r *http.Request) {
	var req watcherConfigSettings
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	bots := cleanList(req.Jira.BotUsernames)
	fields := map[string]string{}
	for k, v := range req.Jira.CustomFields {
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		if k == "" || v == "" {
			writeError(w, http.StatusBadRequest, "custom fields need both a name and a field ID")
			return
		}
		fields[k] = v
	}

	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	path := s.watcherConfigPath()
	cfg, err := wconfig.LoadConfig(path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reading watcher config.yaml: "+err.Error())
		return
	}
	// Start from what is there, so top-level keys this version doesn't
	// edit survive; only the Jira block is replaced.
	next := *cfg
	next.Jira = nil
	if len(bots) > 0 || len(fields) > 0 {
		next.Jira = &wconfig.JiraBehavior{}
		if len(bots) > 0 {
			next.Jira.BotUsernames = bots
		}
		if len(fields) > 0 {
			next.Jira.CustomFields = fields
		}
	}
	if !reflect.DeepEqual(*cfg, next) {
		if err := wconfig.SaveConfig(path, &next); err != nil {
			writeError(w, http.StatusInternalServerError, "saving watcher config.yaml: "+err.Error())
			return
		}
	}
	s.writeSettings(w)
}
