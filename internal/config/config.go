package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	WorktreesBase string     `yaml:"worktrees_base"`
	Jira          JiraConfig `yaml:"jira"`
	Editor        string     `yaml:"editor"`
}

type JiraConfig struct {
	Host     string   `yaml:"host"`
	Email    string   `yaml:"email"`
	Token    string   `yaml:"token"`
	Projects []string `yaml:"projects"`
}

func DefaultConfig() Config {
	home, _ := os.UserHomeDir()
	return Config{
		WorktreesBase: filepath.Join(home, ".worktrees"),
		Jira:          JiraConfig{},
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
