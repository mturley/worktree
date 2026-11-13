package webui

import (
	"encoding/json"
	"maps"
	"net/http"
	"slices"
	"strings"

	wconfig "github.com/mturley/watcher/config"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/worktree/internal/config"
)

// The watcher's settings, as the Settings modal edits them. Its credentials
// are in worktree's watcher-auth.yaml, read and written through the
// library's Load/Save (as `worktree setup` does). Its preferences (bot
// usernames, Jira custom fields) are keys of worktree's own config.yaml,
// read and written through config.ReadEditable/WriteEditable, which keep
// every other key and the file's comments.

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
	// GitHub is always present in what the server sends. In a PUT, absent
	// means "leave the github block as it is", so a client that predates it
	// cannot clear it.
	GitHub *watcherGitHubSettings `json:"github,omitempty"`
	Jira   struct {
		BotUsernames []string          `json:"bot_usernames"`
		CustomFields map[string]string `json:"custom_fields"`
	} `json:"jira"`
}

type watcherGitHubSettings struct {
	// BotUsernames are glob patterns (watcher's botmatch) for logins to
	// treat as bots, e.g. "*ci-bot*".
	BotUsernames []string `json:"bot_usernames"`
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

// watcherConfigFromEditable is the watcher preferences section of the
// settings DTO, from worktree's config.yaml. Absent lists and maps are sent
// as [] and {}.
func watcherConfigFromEditable(e config.Editable) watcherConfigSettings {
	var out watcherConfigSettings
	out.GitHub = &watcherGitHubSettings{BotUsernames: nonNil(e.GitHubBotUsernames)}
	out.Jira.BotUsernames = nonNil(e.JiraBotUsernames)
	out.Jira.CustomFields = map[string]string{}
	maps.Copy(out.Jira.CustomFields, e.JiraCustomFields)
	return out
}

// normalizeJiraHost returns h as a Jira base URL (a bare host gets https://;
// see wjira.NormalizeHost), and false when it isn't an http(s) URL with a
// host. "" (not configured) stays "".
func normalizeJiraHost(h string) (string, bool) {
	if strings.TrimSpace(h) == "" {
		return "", true
	}
	n, err := wjira.NormalizeHost(h)
	return n, err == nil
}

// handleSettingsWatcherAuth: PUT /api/settings/watcher-auth — non-secret
// watcher-auth.yaml fields only. Tokens go through the credential endpoints.
func (s *Server) handleSettingsWatcherAuth(w http.ResponseWriter, r *http.Request) {
	var req watcherAuthSettings
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	host, ok := normalizeJiraHost(req.Jira.Host)
	email := strings.TrimSpace(req.Jira.Email)
	domain := strings.TrimSpace(req.Slack.WorkspaceDomain)
	if !ok {
		writeError(w, http.StatusBadRequest, "Jira host must be an http(s) URL, like https://yourorg.atlassian.net")
		return
	}

	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	cfg, err := s.loadWatcherAuth()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reading watcher-auth.yaml: "+err.Error())
		return
	}
	// The poller sends the stored Jira token to whatever host is saved, so
	// a host change must come with a fresh token (the Replace endpoint).
	if j := cfg.Services.Jira; j != nil && j.Token != "" && !jiraHostEqual(j.Host, host) {
		writeError(w, http.StatusBadRequest, "Changing the Jira host needs the API token too: enter it under API token and press Replace.")
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
			writeError(w, http.StatusInternalServerError, "saving watcher-auth.yaml: "+err.Error())
			return
		}
	}
	s.writeSettings(w)
}

// handleSettingsWatcherConfig: PUT /api/settings/watcher-config — the
// watcher preferences in worktree's config.yaml (github.bot_usernames,
// jira.bot_usernames, jira.custom_fields). Every other key is left as it is.
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
		if _, dup := fields[k]; dup {
			writeError(w, http.StatusBadRequest, "duplicate custom field name: "+k)
			return
		}
		fields[k] = v
	}

	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	path := s.configPath()
	cur, _, err := config.ReadEditable(path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reading config.yaml: "+err.Error())
		return
	}
	next := cur
	// A cleared list with the github block present is written as
	// `bot_usernames: []`, not deleted: `worktree setup` seeds the default
	// only into a config that has never had the block, so a list the user
	// cleared is not refilled on the next install. (Clearing it in a config
	// that never had the block leaves it absent: saving another setting is
	// not a choice about this one.) An absent github block in the request
	// leaves the list as it is.
	if req.GitHub != nil {
		next.GitHubBotUsernames = cleanList(req.GitHub.BotUsernames)
	}
	next.JiraBotUsernames = bots
	next.JiraCustomFields = fields
	changed, err := config.WriteEditable(path, next)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "saving config.yaml: "+err.Error())
		return
	}
	// A changed bot list applies to stored events too, not only to what the
	// next poll brings.
	if changed && (!slices.Equal(cur.GitHubBotUsernames, next.GitHubBotUsernames) ||
		!slices.Equal(cur.JiraBotUsernames, next.JiraBotUsernames)) {
		s.markBotAuthors()
	}
	s.writeSettings(w)
}

func jiraHostEqual(a, b string) bool {
	norm := func(h string) string { return strings.TrimRight(strings.TrimSpace(h), "/") }
	return strings.EqualFold(norm(a), norm(b))
}
