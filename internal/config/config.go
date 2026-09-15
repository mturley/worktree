package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	WorktreesBase string     `yaml:"worktrees_base"`
	Jira          JiraConfig `yaml:"jira"`
	Editor        string     `yaml:"editor"`
	UI            UIConfig   `yaml:"ui"`
}

// JiraConfig holds worktree-only Jira settings. Credentials (host, email,
// API token) live in the shared watcher auth.yaml (wcfg.Services.Jira,
// via credsetup) — see internal/setup/setup.go. Projects has no watcher
// equivalent (it drives worktree's own branch/PR project-prefix detection
// in jira.DetectKeys) and stays here.
type JiraConfig struct {
	Projects []string `yaml:"projects"`
}

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
}

type UITLSConfig struct {
	CertFile string `yaml:"cert_file"`
	KeyFile  string `yaml:"key_file"`
}

// RemoteEnabled reports whether the HTTPS listener for other devices is
// configured. Half a configuration is not enabled; `worktree ui` reports it
// as an error.
func (u UIConfig) RemoteEnabled() bool {
	return u.TLS.CertFile != "" && u.TLS.KeyFile != ""
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
