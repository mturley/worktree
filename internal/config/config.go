package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	WorktreesBase string       `yaml:"worktrees_base"`
	Search        SearchConfig `yaml:"search"`
	Jira          JiraConfig   `yaml:"jira"`
	Editor        string       `yaml:"editor"`
}

type SearchConfig struct {
	Roots []string `yaml:"roots"`
	Depth int      `yaml:"depth"`
	Prune []string `yaml:"prune"`
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
		Search: SearchConfig{
			Roots: []string{home},
			Depth: 5,
			Prune: []string{"node_modules", ".Trash", ".cache", ".venv", "venv"},
		},
		Jira: JiraConfig{},
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
	for i, root := range cfg.Search.Roots {
		cfg.Search.Roots[i] = expandHome(root)
	}

	applyEnvOverrides(&cfg)
	return cfg, nil
}

func applyEnvOverrides(cfg *Config) {
	if v := os.Getenv("WORKTREES_BASE"); v != "" {
		cfg.WorktreesBase = expandHome(v)
	}
	if v := os.Getenv("WORKTREE_SEARCH_ROOTS"); v != "" {
		roots := strings.Split(v, ":")
		for i, r := range roots {
			roots[i] = expandHome(r)
		}
		cfg.Search.Roots = roots
	}
	if v := os.Getenv("WORKTREE_SEARCH_DEPTH"); v != "" {
		if d, err := strconv.Atoi(v); err == nil {
			cfg.Search.Depth = d
		}
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
