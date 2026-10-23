package webui

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/uitls"
)

// The Settings modal edits three files — worktree's config.yaml and the
// watcher library's auth.yaml and config.yaml — through one GET and one PUT
// per file. Secrets are never returned, only whether each is set; they are
// replaced through settings_creds.go. See docs/web-ui-architecture.md
// "Settings modal". A new config key must be added here AND to
// settingsKeyPaths (settings_keys_test.go enforces it).

// cmuxReachable reports whether this server can drive cmux at all
// (IsAvailable, not InPane: the server drives cmux from wherever it runs).
// s.cmuxAvailable is the test seam.
func (s *Server) cmuxReachable() bool {
	if s.cmuxAvailable != nil {
		return s.cmuxAvailable()
	}
	return cmux.IsAvailable()
}

// cmuxEnabled is the gate for every cmux feature: reachable, and not turned
// off in Settings. With it false the server behaves as if cmux were not
// running — every cmux endpoint reports unavailable, so the UI hides its
// cmux controls through the checks it already makes.
func (s *Server) cmuxEnabled() bool {
	return s.cmuxReachable() && !s.cmuxDisabled.Load()
}

// SetCmuxFeaturesDisabled sets the gate's initial state from config, before
// the server starts.
func (s *Server) SetCmuxFeaturesDisabled(disabled bool) {
	s.cmuxDisabled.Store(disabled)
}

func (s *Server) configPath() string {
	if s.ConfigPath != "" {
		return s.ConfigPath
	}
	return config.ConfigPath()
}

func (s *Server) watcherAuthPath() string {
	if s.WatcherAuthPath != "" {
		return s.WatcherAuthPath
	}
	return wconfig.DefaultPath()
}

func (s *Server) watcherConfigPath() string {
	if s.WatcherConfigPath != "" {
		return s.WatcherConfigPath
	}
	return wconfig.ConfigDefaultPath()
}

type settingsEnvironment struct {
	// InCmux is whether the server can reach cmux, regardless of the toggle.
	InCmux bool `json:"in_cmux"`
	// WorktreesBaseEnv: $WORKTREES_BASE is set and overrides worktrees_base.
	WorktreesBaseEnv bool `json:"worktrees_base_env"`
	// CertNames are the names the current HTTPS certificate covers (DNS
	// names and IPs), or nil when there is no readable certificate.
	CertNames []string `json:"cert_names"`
	// DefaultNotifyCommand is what notifications.command falls back to, for
	// the Notifications tab's reset.
	DefaultNotifyCommand string `json:"default_notify_command"`
}

type settingsPaths struct {
	Worktree      string `json:"worktree"`
	WatcherAuth   string `json:"watcher_auth"`
	WatcherConfig string `json:"watcher_config"`
}

type settingsSecrets struct {
	UIPassword  bool `json:"ui_password"`
	GitHubToken bool `json:"github_token"`
	JiraToken   bool `json:"jira_token"`
	SlackToken  bool `json:"slack_token"`
	SlackCookie bool `json:"slack_cookie"`
}

type worktreeSettings struct {
	WorktreesBase       string `json:"worktrees_base"`
	Editor              string `json:"editor"`
	CmuxFeaturesEnabled bool   `json:"cmux_features_enabled"`
	Jira                struct {
		Projects   []string `json:"projects"`
		AliasHosts []string `json:"alias_hosts"`
	} `json:"jira"`
	UI struct {
		// RemoteAccessEnabled inverts ui.remote_access_disabled. A PUT that
		// leaves it out keeps the file's current value.
		RemoteAccessEnabled *bool    `json:"remote_access_enabled"`
		HTTPSPort           int      `json:"https_port"`
		AllowedHosts        []string `json:"allowed_hosts"`
		TLS                 struct {
			CertFile string `json:"cert_file"`
			KeyFile  string `json:"key_file"`
		} `json:"tls"`
	} `json:"ui"`
	// Watchers maps each service (config.Services) to whether its watcher
	// is on. A service missing from a PUT keeps its current state.
	Watchers map[string]bool `json:"watchers"`
	// Notifications is the notifications.* section. A PUT that leaves it
	// out keeps the file's current values.
	Notifications *notificationSettings `json:"notifications"`
	// Git is the git.* section. A PUT that leaves it out keeps the file's
	// current values.
	Git *gitSettings `json:"git"`
}

type gitSettings struct {
	BackgroundFetch bool   `json:"background_fetch"`
	FetchInterval   string `json:"fetch_interval"`
}

type notificationSettings struct {
	// Enabled inverts notifications.disabled.
	Enabled        bool   `json:"enabled"`
	CommandEnabled bool   `json:"command_enabled"`
	Command        string `json:"command"`
}

type settingsDTO struct {
	Environment   settingsEnvironment   `json:"environment"`
	Paths         settingsPaths         `json:"paths"`
	Secrets       settingsSecrets       `json:"secrets"`
	Worktree      worktreeSettings      `json:"worktree"`
	WatcherAuth   watcherAuthSettings   `json:"watcher_auth"`
	WatcherConfig watcherConfigSettings `json:"watcher_config"`
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func toWorktreeSettings(e config.Editable) worktreeSettings {
	var w worktreeSettings
	w.WorktreesBase = e.WorktreesBase
	w.Editor = e.Editor
	w.CmuxFeaturesEnabled = !e.CmuxFeaturesDisabled
	w.Jira.Projects = nonNil(e.JiraProjects)
	w.Jira.AliasHosts = nonNil(e.JiraAliasHosts)
	remote := !e.RemoteAccessDisabled
	w.UI.RemoteAccessEnabled = &remote
	w.UI.HTTPSPort = e.HTTPSPort
	w.UI.AllowedHosts = nonNil(e.AllowedHosts)
	w.UI.TLS.CertFile = e.TLSCertFile
	w.UI.TLS.KeyFile = e.TLSKeyFile
	w.Watchers = map[string]bool{}
	for _, svc := range config.Services {
		w.Watchers[svc] = e.WatcherEnabled(svc)
	}
	w.Notifications = &notificationSettings{
		Enabled:        !e.NotificationsDisabled,
		CommandEnabled: e.NotifyCommandEnabled,
		Command:        e.NotifyCommand,
	}
	w.Git = &gitSettings{BackgroundFetch: e.BackgroundFetch, FetchInterval: e.FetchInterval}
	return w
}

// cleanList trims entries, drops empties and duplicates, keeping order.
func cleanList(in []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func certNames(certFile string) []string {
	if certFile == "" {
		return nil
	}
	cert, err := uitls.ReadCert(config.ExpandHome(certFile))
	if err != nil {
		return nil
	}
	names := append([]string{}, cert.DNSNames...)
	for _, ip := range cert.IPAddresses {
		names = append(names, ip.String())
	}
	return names
}

// homeRelative shortens a path under $HOME to ~/..., for display.
func homeRelative(p string) string {
	if home, err := os.UserHomeDir(); err == nil && strings.HasPrefix(p, home+"/") {
		return "~/" + strings.TrimPrefix(p, home+"/")
	}
	return p
}

// settings assembles the full DTO from disk.
func (s *Server) settings() (settingsDTO, error) {
	e, pwSet, err := config.ReadEditable(s.configPath())
	if err != nil {
		return settingsDTO{}, err
	}
	auth, authSecrets, err := s.readWatcherAuth()
	if err != nil {
		return settingsDTO{}, err
	}
	wcfg, err := s.readWatcherConfig()
	if err != nil {
		return settingsDTO{}, err
	}
	dto := settingsDTO{
		Environment: settingsEnvironment{
			InCmux:           s.cmuxReachable(),
			WorktreesBaseEnv: os.Getenv("WORKTREES_BASE") != "",
			CertNames:        certNames(e.TLSCertFile),

			DefaultNotifyCommand: config.DefaultNotifyCommand,
		},
		Paths: settingsPaths{
			Worktree:      homeRelative(s.configPath()),
			WatcherAuth:   homeRelative(s.watcherAuthPath()),
			WatcherConfig: homeRelative(s.watcherConfigPath()),
		},
		Secrets:       authSecrets,
		Worktree:      toWorktreeSettings(e),
		WatcherAuth:   auth,
		WatcherConfig: wcfg,
	}
	dto.Secrets.UIPassword = pwSet
	// The live gate, not the file, is what the server is doing right now.
	dto.Worktree.CmuxFeaturesEnabled = !s.cmuxDisabled.Load()
	dto.Worktree.Watchers = s.watcherStates()
	return dto, nil
}

func (s *Server) writeSettings(w http.ResponseWriter) {
	dto, err := s.settings()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reading settings: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, dto)
}

// handleSettings: GET /api/settings
func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	s.writeSettings(w)
}

// handleSettingsWorktree: PUT /api/settings/worktree — the whole worktree
// section. Persists to the file first and only then moves live state (the
// cmux gate, Jira alias hosts), so a failed write never leaves the server
// disagreeing with what it will load on restart.
func (s *Server) handleSettingsWorktree(w http.ResponseWriter, r *http.Request) {
	var req worktreeSettings
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if p := req.UI.HTTPSPort; p < 1 || p > 65535 {
		writeError(w, http.StatusBadRequest, "HTTPS port must be between 1 and 65535")
		return
	}
	next := config.Editable{
		WorktreesBase:        strings.TrimSpace(req.WorktreesBase),
		Editor:               strings.TrimSpace(req.Editor),
		JiraProjects:         cleanList(req.Jira.Projects),
		JiraAliasHosts:       cleanList(req.Jira.AliasHosts),
		HTTPSPort:            req.UI.HTTPSPort,
		AllowedHosts:         cleanList(req.UI.AllowedHosts),
		TLSCertFile:          strings.TrimSpace(req.UI.TLS.CertFile),
		TLSKeyFile:           strings.TrimSpace(req.UI.TLS.KeyFile),
		CmuxFeaturesDisabled: !req.CmuxFeaturesEnabled,
		WatchersDisabled:     map[string]bool{},
	}
	for svc, on := range req.Watchers {
		if !slices.Contains(config.Services, svc) {
			writeError(w, http.StatusBadRequest, "unknown watcher "+svc)
			return
		}
		if !on {
			next.WatchersDisabled[svc] = true
		}
	}
	for _, h := range next.AllowedHosts {
		if strings.ContainsAny(h, " /:") && net.ParseIP(h) == nil {
			writeError(w, http.StatusBadRequest, "allowed host "+h+" is not a host name or IP")
			return
		}
	}

	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()

	// A service the request leaves out keeps its live state.
	for _, svc := range config.Services {
		if _, ok := req.Watchers[svc]; !ok && !s.WatcherEnabled(svc) {
			next.WatchersDisabled[svc] = true
		}
	}

	cur, _, curErr := config.ReadEditable(s.configPath())
	if req.UI.RemoteAccessEnabled != nil {
		next.RemoteAccessDisabled = !*req.UI.RemoteAccessEnabled
	} else if curErr == nil {
		next.RemoteAccessDisabled = cur.RemoteAccessDisabled
	}
	if n := req.Notifications; n != nil {
		next.NotificationsDisabled = !n.Enabled
		next.NotifyCommandEnabled = n.CommandEnabled
		next.NotifyCommand = strings.TrimSpace(n.Command)
	} else if curErr == nil {
		next.NotificationsDisabled = cur.NotificationsDisabled
		next.NotifyCommandEnabled = cur.NotifyCommandEnabled
		next.NotifyCommand = cur.NotifyCommand
	}
	if g := req.Git; g != nil {
		next.BackgroundFetch = g.BackgroundFetch
		next.FetchInterval = strings.TrimSpace(g.FetchInterval)
		// Interval() would silently floor or default these; reject instead
		// so the user sees why their value didn't stick.
		d, err := time.ParseDuration(next.FetchInterval)
		if err != nil || d < config.MinFetchInterval {
			writeError(w, http.StatusBadRequest, "fetch interval must be a duration of at least 1m, like 3m")
			return
		}
	} else if curErr == nil {
		next.BackgroundFetch = cur.BackgroundFetch
		next.FetchInterval = cur.FetchInterval
	} else {
		next.BackgroundFetch = true
		next.FetchInterval = config.DefaultFetchInterval
	}
	if next.NotifyCommandEnabled && next.NotifyCommand == "" {
		next.NotifyCommand = config.DefaultNotifyCommand
	}

	disabled := next.CmuxFeaturesDisabled
	cmuxChanging := disabled != s.cmuxDisabled.Load()
	if cmuxChanging && !s.cmuxReachable() {
		writeError(w, http.StatusConflict, "cmux is not available to this server")
		return
	}
	if _, err := config.WriteEditable(s.configPath(), next); err != nil {
		writeError(w, http.StatusInternalServerError, "saving config: "+err.Error())
		return
	}
	jira.SetAliasHosts(next.JiraAliasHosts)
	s.applyWatchers(next.WatchersDisabled)
	s.SetNotifications(config.NotificationsConfig{
		Disabled:       next.NotificationsDisabled,
		CommandEnabled: next.NotifyCommandEnabled,
		Command:        next.NotifyCommand,
	})
	if cmuxChanging {
		s.cmuxDisabled.Store(disabled)
		if disabled {
			// The gate is already shut, so no unread pass can put the 📬
			// prefixes back after this takes them off.
			s.cmuxUnreadStrip()
		}
		s.logger().Printf("settings: cmux features %s", map[bool]string{true: "disabled", false: "enabled"}[disabled])
	}
	s.writeSettings(w)
}
