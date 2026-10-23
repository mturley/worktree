package config

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	WorktreesBase string              `yaml:"worktrees_base"`
	Jira          JiraConfig          `yaml:"jira"`
	Editor        string              `yaml:"editor"`
	UI            UIConfig            `yaml:"ui"`
	Watchers      WatchersConfig      `yaml:"watchers,omitempty"`
	Notifications NotificationsConfig `yaml:"notifications,omitempty"`
	Git           GitConfig           `yaml:"git,omitempty"`
}

// Defaults and floor for the background git fetch. DefaultFetchInterval is
// the text form so the Settings modal shows (and the file omits) "3m".
const (
	DefaultFetchInterval = "3m"
	defaultFetchDuration = 3 * time.Minute
	MinFetchInterval     = time.Minute
)

// GitConfig controls the background `git fetch` that keeps a worktree's Code
// tab comparison fresh. Set from the Settings modal's General tab.
type GitConfig struct {
	// BackgroundFetch is a pointer so an absent key reads as on.
	BackgroundFetch *bool `yaml:"background_fetch,omitempty"`
	// FetchInterval is a Go duration ("3m"). Empty or unparsable means
	// DefaultFetchInterval; anything under MinFetchInterval is raised to it.
	FetchInterval string `yaml:"fetch_interval,omitempty"`
}

// FetchEnabled reports whether the background fetch is on (the default).
func (g GitConfig) FetchEnabled() bool { return g.BackgroundFetch == nil || *g.BackgroundFetch }

// Interval is how often to fetch, with the default and floor applied.
func (g GitConfig) Interval() time.Duration {
	d, err := time.ParseDuration(strings.TrimSpace(g.FetchInterval))
	if err != nil {
		return defaultFetchDuration
	}
	if d < MinFetchInterval {
		return MinFetchInterval
	}
	return d
}

// DefaultNotifyCommand is the custom notification command used when
// notifications.command is unset.
const DefaultNotifyCommand = `telert send "$event ($resource) - $description - $worktree ($cmuxtitle)"`

// NotificationsConfig holds the web UI's custom notification command: a
// shell command run once per delivered notification, alongside the cmux or
// browser notification. Set from the Settings modal's Notifications tab.
type NotificationsConfig struct {
	// Disabled turns every notification off (cmux, browser and the custom
	// command) without touching the per-worktree toggles, which come back
	// when it is turned on again. Absent means enabled.
	Disabled       bool `yaml:"disabled,omitempty"`
	CommandEnabled bool `yaml:"command_enabled,omitempty"`
	// Command runs under sh -c with $event, $resource, $description,
	// $worktree and $cmuxtitle set as shell variables. Empty means
	// DefaultNotifyCommand.
	Command string `yaml:"command,omitempty"`
}

// EffectiveCommand is the command to run, or "" when it is turned off.
func (n NotificationsConfig) EffectiveCommand() string {
	if n.Disabled || !n.CommandEnabled {
		return ""
	}
	if strings.TrimSpace(n.Command) == "" {
		return DefaultNotifyCommand
	}
	return n.Command
}

// The services worktree's watcher connects to, as named in WatchersConfig.
const (
	ServiceGitHub = "github"
	ServiceJira   = "jira"
	ServiceSlack  = "slack"
)

// Services lists every service a watcher can be turned off for.
var Services = []string{ServiceGitHub, ServiceJira, ServiceSlack}

// WatchersConfig turns worktree's connection to a service off. A missing
// key means on; only `false` is ever written. Off means no polling, linked
// resources or (Slack) live thread view — existing resources still show
// from the DB. Set from the Settings modal or `worktree setup`.
type WatchersConfig struct {
	GitHub *bool `yaml:"github,omitempty"`
	Jira   *bool `yaml:"jira,omitempty"`
	Slack  *bool `yaml:"slack,omitempty"`
}

// Enabled reports whether worktree may connect to svc (a Service* name).
func (w WatchersConfig) Enabled(svc string) bool {
	var v *bool
	switch svc {
	case ServiceGitHub:
		v = w.GitHub
	case ServiceJira:
		v = w.Jira
	case ServiceSlack:
		v = w.Slack
	}
	return v == nil || *v
}

// SetEnabled records svc's state: nil (the default) for on, false for off.
func (w *WatchersConfig) SetEnabled(svc string, on bool) {
	var v *bool
	if !on {
		v = new(bool)
	}
	switch svc {
	case ServiceGitHub:
		w.GitHub = v
	case ServiceJira:
		w.Jira = v
	case ServiceSlack:
		w.Slack = v
	}
}

// JiraConfig holds worktree-only Jira settings. Credentials (host, email,
// API token) live in the shared watcher auth.yaml (wcfg.Services.Jira,
// via credsetup) — see internal/setup/setup.go. Projects has no watcher
// equivalent (it drives worktree's own branch/PR project-prefix detection
// in jira.DetectKeys) and stays here.
type JiraConfig struct {
	Projects []string `yaml:"projects"`
	// AliasHosts are extra hosts whose /browse/KEY pages are Jira issues —
	// e.g. an instance's pre-migration address (issues.example.com) that now
	// redirects to its atlassian.net site — so old links are still recognised.
	AliasHosts []string `yaml:"alias_hosts,omitempty"`
}

// DefaultHTTPPort is the port the web UI's loopback HTTP listener binds
// unless `worktree ui --port` says otherwise.
const DefaultHTTPPort = 8475

// DefaultHTTPSPort is the port the web UI's HTTPS listener binds when
// ui.https_port is unset. The plain-HTTP listener keeps its own --port.
const DefaultHTTPSPort = 8476

// UIConfig holds the web UI's authentication and remote-access settings.
type UIConfig struct {
	// Password is required: `worktree ui` refuses to start without it.
	Password  string `yaml:"password"`
	HTTPSPort int    `yaml:"https_port"`
	// AllowedHosts are the names and IPs other devices use to reach this
	// machine. They are both the certificate's SANs and the Host allowlist,
	// beyond the loopback names that are always allowed.
	AllowedHosts []string    `yaml:"allowed_hosts"`
	TLS          UITLSConfig `yaml:"tls"`
	// CmuxFeaturesDisabled turns off everything the web UI does with cmux,
	// even when the server can reach it. Set from the UI's Settings modal via
	// SetCmuxFeaturesDisabled; absent means enabled.
	CmuxFeaturesDisabled bool `yaml:"cmux_features_disabled,omitempty"`
	// RemoteAccessDisabled keeps `worktree ui` from serving HTTPS even
	// when a certificate is configured, without discarding it. Set from the
	// Settings modal or `worktree setup`; absent means enabled.
	RemoteAccessDisabled bool `yaml:"remote_access_disabled,omitempty"`
}

type UITLSConfig struct {
	CertFile string `yaml:"cert_file"`
	KeyFile  string `yaml:"key_file"`
}

// RemoteEnabled reports whether the HTTPS listener for other devices is
// configured. Half a configuration is not enabled; `worktree ui` reports it
// as an error. It ignores RemoteAccessDisabled: a configured but turned-off
// listener still has a certificate worth keeping.
func (u UIConfig) RemoteEnabled() bool {
	return u.TLS.CertFile != "" && u.TLS.KeyFile != ""
}

// RemoteURL is the address to open on another device, or "" if none is
// configured.
func (u UIConfig) RemoteURL() string {
	if len(u.AllowedHosts) == 0 {
		return ""
	}
	return "https://" + net.JoinHostPort(u.AllowedHosts[0], strconv.Itoa(u.HTTPSPort))
}

func DefaultConfig() Config {
	home, _ := os.UserHomeDir()
	return Config{
		WorktreesBase: filepath.Join(home, ".worktrees"),
		Jira:          JiraConfig{},
		UI:            UIConfig{HTTPSPort: DefaultHTTPSPort},
	}
}

func configPath() string {
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, "worktree", "config.yaml")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "worktree", "config.yaml")
}

func ConfigPath() string {
	return configPath()
}

func Load() (Config, error) {
	cfg := DefaultConfig()

	data, err := os.ReadFile(configPath())
	if err == nil {
		if err := yaml.Unmarshal(data, &cfg); err != nil {
			return cfg, fmt.Errorf("parsing config: %w", err)
		}
	}

	cfg.WorktreesBase = expandHome(cfg.WorktreesBase)
	cfg.UI.TLS.CertFile = expandHome(cfg.UI.TLS.CertFile)
	cfg.UI.TLS.KeyFile = expandHome(cfg.UI.TLS.KeyFile)
	if cfg.UI.HTTPSPort == 0 {
		cfg.UI.HTTPSPort = DefaultHTTPSPort
	}

	applyEnvOverrides(&cfg)
	return cfg, nil
}

func applyEnvOverrides(cfg *Config) {
	if v := os.Getenv("WORKTREES_BASE"); v != "" {
		cfg.WorktreesBase = expandHome(v)
	}
}

func ExpandHome(path string) string {
	return expandHome(path)
}

func expandHome(path string) string {
	if strings.HasPrefix(path, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, path[2:])
	}
	return path
}

// PermissionsTooOpen reports whether the file at path grants any access to
// group or other. A missing file is not an error: there is nothing to expose.
func PermissionsTooOpen(path string) (bool, error) {
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return info.Mode().Perm()&0o077 != 0, nil
}
