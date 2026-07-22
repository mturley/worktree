package setup

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/ui"
	"gopkg.in/yaml.v3"
)

type Plan struct {
	CreateWorktreesBase  bool
	WorktreesBase        string
	InstallShellRC       bool
	ShellRC              ShellRC
	CreateConfig         bool
	ConfigPath           string
	UpdateCompletion     bool
	SuggestCompletion    bool
	CompletionPath       string
	CompletionShell      string
}

func BuildPlan(cfg config.Config) Plan {
	rc := DetectShellRC()
	plan := Plan{
		WorktreesBase: cfg.WorktreesBase,
		ShellRC:       rc,
		ConfigPath:    config.ConfigPath(),
	}

	if _, err := os.Stat(cfg.WorktreesBase); os.IsNotExist(err) {
		plan.CreateWorktreesBase = true
	}
	if !rc.IsInstalled() {
		plan.InstallShellRC = true
	}
	if _, err := os.Stat(config.ConfigPath()); os.IsNotExist(err) {
		plan.CreateConfig = true
	}

	plan.CompletionShell = rc.Shell
	plan.CompletionPath = completionPath(rc.Shell)
	if plan.CompletionPath != "" {
		if _, err := os.Stat(plan.CompletionPath); err == nil {
			plan.UpdateCompletion = true
		} else {
			plan.SuggestCompletion = true
		}
	}

	return plan
}

func (p Plan) Preview() {
	fmt.Println(ui.Bold("worktree setup will:"))
	if p.CreateWorktreesBase {
		fmt.Printf("  • Create worktrees directory: %s\n", ui.ShortPath(p.WorktreesBase))
	}
	if p.InstallShellRC {
		fmt.Printf("  • %s\n", p.ShellRC.Description())
	}
	if p.CreateConfig {
		fmt.Printf("  • Create default config: %s\n", ui.ShortPath(p.ConfigPath))
	}
	if p.UpdateCompletion {
		fmt.Printf("  • Update shell completion: %s\n", ui.ShortPath(p.CompletionPath))
	}
	if !p.CreateWorktreesBase && !p.InstallShellRC && !p.CreateConfig && !p.UpdateCompletion {
		fmt.Println("  Nothing to do — already set up.")
	}
	if p.SuggestCompletion {
		fmt.Printf("\n  %s Shell completion is not installed.\n", ui.Dim("tip:"))
		fmt.Printf("       Run %s for setup instructions.\n", ui.Bold("worktree completion --help"))
	}
}

func (p Plan) HasWork() bool {
	return p.CreateWorktreesBase || p.InstallShellRC || p.CreateConfig || p.UpdateCompletion
}

func (p Plan) Execute() error {
	if p.CreateWorktreesBase {
		if err := os.MkdirAll(p.WorktreesBase, 0755); err != nil {
			return fmt.Errorf("creating worktrees base: %w", err)
		}
		fmt.Printf("  %s Created %s\n", ui.Green("✓"), ui.ShortPath(p.WorktreesBase))
	}

	if p.InstallShellRC {
		if err := p.ShellRC.Install(); err != nil {
			return fmt.Errorf("installing shell RC: %w", err)
		}
		fmt.Printf("  %s %s\n", ui.Green("✓"), p.ShellRC.Description())
	}

	if p.CreateConfig {
		if err := writeDefaultConfig(p.ConfigPath); err != nil {
			return fmt.Errorf("creating config: %w", err)
		}
		fmt.Printf("  %s Created %s\n", ui.Green("✓"), ui.ShortPath(p.ConfigPath))
	}

	if p.UpdateCompletion {
		if err := writeCompletion(p.CompletionShell, p.CompletionPath); err != nil {
			return fmt.Errorf("updating shell completion: %w", err)
		}
		fmt.Printf("  %s Updated %s\n", ui.Green("✓"), ui.ShortPath(p.CompletionPath))
	}

	return nil
}

func PreviewUninstall(rc ShellRC, configPath string) {
	fmt.Println(ui.Bold("worktree setup --uninstall will:"))
	if rc.IsInstalled() {
		fmt.Printf("  • Remove auto-source from %s\n", rc.Path)
	}
	if _, err := os.Stat(configPath); err == nil {
		fmt.Printf("  • Remove config: %s\n", ui.ShortPath(configPath))
	}
	fmt.Println("  • Preserve worktree data (remove manually if desired)")
}

func ExecuteUninstall(rc ShellRC, configPath string) error {
	if rc.IsInstalled() {
		if err := rc.Uninstall(); err != nil {
			return fmt.Errorf("removing shell RC: %w", err)
		}
		fmt.Printf("  %s Removed auto-source from %s\n", ui.Green("✓"), rc.Path)
	}

	if _, err := os.Stat(configPath); err == nil {
		if err := os.Remove(configPath); err != nil {
			return fmt.Errorf("removing config: %w", err)
		}
		configDir := filepath.Dir(configPath)
		os.Remove(configDir) // remove dir if empty, ignore error
		fmt.Printf("  %s Removed %s\n", ui.Green("✓"), ui.ShortPath(configPath))
	}

	return nil
}

func writeDefaultConfig(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	cfg := config.DefaultConfig()
	home, _ := os.UserHomeDir()

	type yamlConfig struct {
		WorktreesBase string `yaml:"worktrees_base"`
		Search        struct {
			Roots []string `yaml:"roots"`
			Depth int      `yaml:"depth"`
			Prune []string `yaml:"prune"`
		} `yaml:"search"`
	}

	yc := yamlConfig{
		WorktreesBase: shortenHome(cfg.WorktreesBase, home),
	}
	yc.Search.Roots = make([]string, len(cfg.Search.Roots))
	for i, r := range cfg.Search.Roots {
		yc.Search.Roots[i] = shortenHome(r, home)
	}
	yc.Search.Depth = cfg.Search.Depth
	yc.Search.Prune = cfg.Search.Prune

	data, err := yaml.Marshal(yc)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func shortenHome(path, home string) string {
	if home != "" && len(path) > len(home) && path[:len(home)] == home {
		return "~" + path[len(home):]
	}
	return path
}

func completionPath(shell string) string {
	switch shell {
	case "zsh":
		if prefix, err := exec.Command("brew", "--prefix").Output(); err == nil {
			p := filepath.Join(strings.TrimSpace(string(prefix)), "share", "zsh", "site-functions", "_worktree")
			if dir := filepath.Dir(p); dirExists(dir) {
				return p
			}
		}
		home, _ := os.UserHomeDir()
		p := filepath.Join(home, ".zsh", "completions", "_worktree")
		if dir := filepath.Dir(p); dirExists(dir) {
			return p
		}
	case "bash":
		for _, dir := range []string{"/etc/bash_completion.d", "/usr/local/etc/bash_completion.d"} {
			if dirExists(dir) {
				return filepath.Join(dir, "worktree")
			}
		}
	case "fish":
		home, _ := os.UserHomeDir()
		dir := filepath.Join(home, ".config", "fish", "completions")
		if dirExists(dir) {
			return filepath.Join(dir, "worktree.fish")
		}
	}
	return ""
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func writeCompletion(shell, path string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	out, err := exec.Command(exe, "completion", shell).Output()
	if err != nil {
		return fmt.Errorf("generating completion script: %w", err)
	}
	return os.WriteFile(path, bytes.TrimSpace(out), 0644)
}
