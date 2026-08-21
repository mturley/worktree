package setup

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/watcher/credsetup"
	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/ui"
	"gopkg.in/yaml.v3"
)

type Plan struct {
	CreateWorktreesBase   bool
	WorktreesBase         string
	InstallShellRC        bool
	ShellRC               ShellRC
	CreateConfig          bool
	ConfigPath            string
	InstallCompletions    bool
	CompletionsExist      bool
	ConfigureJiraProjects bool
	TestGitHubCreds       bool
	TestSlackCreds        bool
	TestJiraCreds         bool
	GHMissing             bool
	GHNotAuthenticated    bool
	Cfg                   config.Config
}

func BuildPlan(cfg config.Config) Plan {
	rc := DetectShellRC()
	plan := Plan{
		WorktreesBase: cfg.WorktreesBase,
		ShellRC:       rc,
		ConfigPath:    config.ConfigPath(),
		Cfg:           cfg,
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
	if len(cfg.Jira.Projects) == 0 {
		plan.ConfigureJiraProjects = true
	}

	// GitHub, Slack, and Jira credentials are tested (and repaired if
	// needed) via the shared credsetup.TestAndRepair flow every run, even
	// when already configured — see Plan.Execute.
	plan.TestGitHubCreds = true
	plan.TestSlackCreds = true
	plan.TestJiraCreds = true

	if _, err := exec.LookPath("gh"); err != nil {
		plan.GHMissing = true
	} else {
		cmd := exec.Command("gh", "auth", "status")
		if err := cmd.Run(); err != nil {
			plan.GHNotAuthenticated = true
		}
	}

	plan.InstallCompletions = true
	dir := completionDir(rc.Shell)
	if dir != "" {
		if _, err := os.Stat(filepath.Join(dir, completionFilename(rc.Shell, "worktree"))); err == nil {
			plan.CompletionsExist = true
		}
	}

	return plan
}

func (p Plan) Preview() {
	hasExisting := false
	if !p.CreateWorktreesBase {
		if !hasExisting {
			fmt.Println(ui.Dim("Already set up:"))
			hasExisting = true
		}
		fmt.Printf("  %s Worktrees directory: %s\n", ui.Green("✓"), ui.ShortPath(p.WorktreesBase))
	}
	if !p.InstallShellRC {
		if !hasExisting {
			fmt.Println(ui.Dim("Already set up:"))
			hasExisting = true
		}
		fmt.Printf("  %s Shell auto-source (%s)\n", ui.Green("✓"), p.ShellRC.Shell)
	}
	if !p.CreateConfig {
		if !hasExisting {
			fmt.Println(ui.Dim("Already set up:"))
			hasExisting = true
		}
		fmt.Printf("  %s Config: %s\n", ui.Green("✓"), ui.ShortPath(p.ConfigPath))
	}
	if !p.ConfigureJiraProjects && len(p.Cfg.Jira.Projects) > 0 {
		if !hasExisting {
			fmt.Println(ui.Dim("Already set up:"))
			hasExisting = true
		}
		fmt.Printf("  %s Jira projects: %s\n", ui.Green("✓"), strings.Join(p.Cfg.Jira.Projects, ", "))
	}
	if !p.GHMissing && !p.GHNotAuthenticated {
		if !hasExisting {
			fmt.Println(ui.Dim("Already set up:"))
			hasExisting = true
		}
		fmt.Printf("  %s GitHub CLI (gh)\n", ui.Green("✓"))
	}
	if hasExisting {
		fmt.Println()
	}

	hasWork := p.HasWork() || p.GHMissing || p.GHNotAuthenticated
	if hasWork {
		fmt.Println(ui.Bold("worktree setup will:"))
	}
	if p.CreateWorktreesBase {
		fmt.Printf("  • Create worktrees directory: %s\n", ui.ShortPath(p.WorktreesBase))
	}
	if p.InstallShellRC {
		fmt.Printf("  • %s\n", p.ShellRC.Description())
	}
	if p.CreateConfig {
		fmt.Printf("  • Create config: %s\n", ui.ShortPath(p.ConfigPath))
	}
	if p.InstallCompletions {
		if p.CompletionsExist {
			fmt.Println("  • Update shell completions (worktree + wt)")
		} else {
			fmt.Println("  • Install shell completions (worktree + wt)")
		}
	}
	if p.TestGitHubCreds {
		fmt.Println("  • Test GitHub credentials")
	}
	if p.TestSlackCreds {
		fmt.Println("  • Test Slack credentials")
	}
	if p.TestJiraCreds {
		fmt.Println("  • Test Jira credentials")
	}
	if p.ConfigureJiraProjects {
		fmt.Println("  • Configure Jira project prefixes (optional)")
	}
	if p.GHMissing {
		fmt.Printf("\n  %s GitHub CLI (gh) is not installed. PR features will be unavailable.\n", ui.Yellow("!"))
		fmt.Printf("       Install: %s\n", ui.Bold("https://cli.github.com/"))
	} else if p.GHNotAuthenticated {
		fmt.Printf("\n  %s GitHub CLI (gh) is not authenticated. PR features will be unavailable.\n", ui.Yellow("!"))
		fmt.Printf("       Run: %s\n", ui.Bold("gh auth login"))
	}
	if !hasWork {
		fmt.Println("Nothing to do — already set up.")
	}
}

func (p Plan) HasWork() bool {
	return p.CreateWorktreesBase || p.InstallShellRC || p.CreateConfig || p.InstallCompletions || p.ConfigureJiraProjects || p.TestGitHubCreds || p.TestSlackCreds || p.TestJiraCreds
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
		if err := promptAndSaveConfig(p.ConfigPath, p.Cfg); err != nil {
			return fmt.Errorf("creating config: %w", err)
		}
	}

	if p.InstallCompletions {
		installAllCompletions()
	}

	if p.TestGitHubCreds || p.TestSlackCreds || p.TestJiraCreds {
		if err := testAndRepairSharedCreds(p.TestGitHubCreds, p.TestSlackCreds, p.TestJiraCreds); err != nil {
			fmt.Printf("  %s Credential setup failed: %v\n", ui.Yellow("!"), err)
		}
	}

	if p.ConfigureJiraProjects {
		if err := promptAndSaveJiraProjects(p.ConfigPath, p.Cfg); err != nil {
			return fmt.Errorf("configuring Jira projects: %w", err)
		}
	}

	return nil
}

// testAndRepairSharedCreds runs the shared watcher credsetup.TestAndRepair
// flow for GitHub, Slack, and/or Jira, loading and (if anything changed)
// saving the watcher config exactly once. Jira credentials (host, email,
// token) live in the watcher config (wcfg.Services.Jira) — worktree's own
// config.yaml only keeps Jira project prefixes (config.JiraConfig.Projects),
// which have no watcher equivalent and are handled separately by
// promptAndSaveJiraProjects.
func testAndRepairSharedCreds(testGitHub, testSlack, testJira bool) error {
	wcfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		return fmt.Errorf("loading watcher config: %w", err)
	}

	var prompter Prompter
	changed := false

	if testGitHub {
		c, err := credsetup.TestAndRepair(wcfg, credsetup.GitHub, prompter)
		if err != nil {
			fmt.Printf("  %s GitHub credential test failed: %v\n", ui.Yellow("!"), err)
		}
		changed = changed || c
	}

	if testSlack {
		c, err := credsetup.TestAndRepair(wcfg, credsetup.Slack, prompter)
		if err != nil {
			fmt.Printf("  %s Slack credential test failed: %v\n", ui.Yellow("!"), err)
		}
		changed = changed || c
	}

	if testJira {
		c, err := credsetup.TestAndRepair(wcfg, credsetup.Jira, prompter)
		if err != nil {
			fmt.Printf("  %s Jira credential test failed: %v\n", ui.Yellow("!"), err)
		}
		changed = changed || c
	}

	if changed {
		if err := wcfg.Save(wconfig.DefaultPath()); err != nil {
			return fmt.Errorf("saving watcher config: %w", err)
		}
		fmt.Printf("  %s Updated %s\n", ui.Green("✓"), ui.ShortPath(wconfig.DefaultPath()))
	}

	return nil
}

func promptAndSaveConfig(configPath string, cfg config.Config) error {
	home, _ := os.UserHomeDir()

	fmt.Println()
	wtBase := ui.PromptLineDefault("  Where should worktrees be created?", shortenHome(cfg.WorktreesBase, home))
	cfg.WorktreesBase = config.ExpandHome(wtBase)

	if err := writeConfig(configPath, cfg); err != nil {
		return err
	}
	fmt.Printf("  %s Created %s\n", ui.Green("✓"), ui.ShortPath(configPath))
	return nil
}

// promptAndSaveJiraProjects prompts for the Jira project prefixes that
// drive worktree's own branch/PR project detection (jira.DetectKeys) and
// persists them to worktree's config.yaml. Jira credentials (host, email,
// token) are handled separately via testAndRepairSharedCreds — this step
// is worktree-local and independent of whether Jira credentials are
// configured.
func promptAndSaveJiraProjects(configPath string, cfg config.Config) error {
	fmt.Println()
	fmt.Println(ui.Bold("Jira project prefixes (optional — press Enter to skip):"))

	projectsStr := ui.PromptLineDefault("  Jira project prefixes (comma-separated, e.g. MYPROJ,OTHER)", strings.Join(cfg.Jira.Projects, ","))

	var projects []string
	for _, p := range strings.Split(projectsStr, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			projects = append(projects, p)
		}
	}

	if len(projects) == 0 {
		fmt.Printf("  %s No projects configured — Jira issue detection will be disabled\n", ui.Dim("—"))
		return nil
	}

	cfg.Jira.Projects = projects
	if err := writeConfig(configPath, cfg); err != nil {
		return err
	}
	fmt.Printf("  %s Configured Jira projects: %s\n", ui.Green("✓"), strings.Join(projects, ", "))
	fmt.Printf("  %s Updated %s\n", ui.Green("✓"), ui.ShortPath(configPath))
	return nil
}

func PreviewUninstall(rc ShellRC, configPath string) {
	fmt.Println(ui.Bold("worktree setup --uninstall will:"))
	if rc.IsInstalled() {
		fmt.Printf("  • Remove auto-source from %s\n", rc.Path)
	}
	if wtSymlink := wtSymlinkPath(); wtSymlink != "" {
		fmt.Printf("  • Remove wt symlink: %s\n", wtSymlink)
	}
	fmt.Println("  • Remove shell completions (worktree + wt)")
	fmt.Println("  • Preserve worktree data (remove manually if desired)")
	if _, err := os.Stat(configPath); err == nil {
		fmt.Printf("  • Preserve config at %s (contains credentials)\n", ui.ShortPath(configPath))
	}
}

func ExecuteUninstall(rc ShellRC, configPath string) error {
	if rc.IsInstalled() {
		if err := rc.Uninstall(); err != nil {
			return fmt.Errorf("removing shell RC: %w", err)
		}
		fmt.Printf("  %s Removed auto-source from %s\n", ui.Green("✓"), rc.Path)
	}

	if wtSymlink := wtSymlinkPath(); wtSymlink != "" {
		if err := os.Remove(wtSymlink); err == nil {
			fmt.Printf("  %s Removed %s\n", ui.Green("✓"), wtSymlink)
		}
	}

	removeAllCompletions()

	if _, err := os.Stat(configPath); err == nil {
		fmt.Printf("  %s Config preserved at %s\n", ui.Dim("—"), ui.ShortPath(configPath))
		fmt.Printf("    Remove manually: rm %s\n", ui.ShortPath(configPath))
	}

	return nil
}

func wtSymlinkPath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	wtPath := filepath.Join(filepath.Dir(exe), "wt")
	target, err := os.Readlink(wtPath)
	if err != nil {
		return ""
	}
	if target == "worktree" || filepath.Base(target) == "worktree" {
		return wtPath
	}
	return ""
}

func writeDefaultConfig(path string) error {
	return writeConfig(path, config.DefaultConfig())
}

func writeConfig(path string, cfg config.Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	home, _ := os.UserHomeDir()

	type jiraYaml struct {
		Projects []string `yaml:"projects,omitempty"`
	}

	type yamlConfig struct {
		WorktreesBase string   `yaml:"worktrees_base"`
		Editor        string   `yaml:"editor,omitempty"`
		Jira          jiraYaml `yaml:"jira,omitempty"`
	}

	yc := yamlConfig{
		WorktreesBase: shortenHome(cfg.WorktreesBase, home),
		Editor:        cfg.Editor,
	}

	if len(cfg.Jira.Projects) > 0 {
		yc.Jira = jiraYaml{
			Projects: cfg.Jira.Projects,
		}
	}

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

func completionDir(shell string) string {
	switch shell {
	case "zsh":
		if prefix, err := exec.Command("brew", "--prefix").Output(); err == nil {
			return filepath.Join(strings.TrimSpace(string(prefix)), "share", "zsh", "site-functions")
		}
		return "/usr/local/share/zsh/site-functions"
	case "bash":
		if prefix, err := exec.Command("brew", "--prefix").Output(); err == nil {
			return filepath.Join(strings.TrimSpace(string(prefix)), "etc", "bash_completion.d")
		}
		return "/etc/bash_completion.d"
	case "fish":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".config", "fish", "completions")
	}
	return ""
}

func completionFilename(shell, cmd string) string {
	switch shell {
	case "zsh":
		return "_" + cmd
	case "fish":
		return cmd + ".fish"
	default:
		return cmd
	}
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

func writeWtCompletion(shell, path string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	out, err := exec.Command(exe, "completion", shell).Output()
	if err != nil {
		return fmt.Errorf("generating completion script: %w", err)
	}
	script := string(bytes.TrimSpace(out))
	script = strings.ReplaceAll(script, "worktree", "wt")
	return os.WriteFile(path, []byte(script), 0644)
}

var allShells = []string{"zsh", "bash", "fish"}

func installAllCompletions() {
	for _, shell := range allShells {
		dir := completionDir(shell)
		if dir == "" {
			continue
		}
		os.MkdirAll(dir, 0755)

		wtPath := filepath.Join(dir, completionFilename(shell, "worktree"))
		if err := writeCompletion(shell, wtPath); err != nil {
			continue
		}
		fmt.Printf("  %s %s\n", ui.Green("✓"), ui.ShortPath(wtPath))

		wtAliasPath := filepath.Join(dir, completionFilename(shell, "wt"))
		if err := writeWtCompletion(shell, wtAliasPath); err != nil {
			continue
		}
		fmt.Printf("  %s %s\n", ui.Green("✓"), ui.ShortPath(wtAliasPath))
	}
}

func removeAllCompletions() {
	for _, shell := range allShells {
		dir := completionDir(shell)
		if dir == "" {
			continue
		}
		for _, cmd := range []string{"worktree", "wt"} {
			p := filepath.Join(dir, completionFilename(shell, cmd))
			if err := os.Remove(p); err == nil {
				fmt.Printf("  %s Removed %s\n", ui.Green("✓"), ui.ShortPath(p))
			}
		}
	}
}
