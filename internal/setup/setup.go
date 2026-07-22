package setup

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/jira"
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
	InstallCompletions   bool
	ConfigureJira        bool
	TestJira             bool
	GHMissing            bool
	GHNotAuthenticated   bool
	Cfg                  config.Config
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
		plan.ConfigureJira = true
	} else if cfg.Jira.Token != "" {
		plan.TestJira = true
	}

	if _, err := exec.LookPath("gh"); err != nil {
		plan.GHMissing = true
	} else {
		cmd := exec.Command("gh", "auth", "status")
		if err := cmd.Run(); err != nil {
			plan.GHNotAuthenticated = true
		}
	}

	plan.InstallCompletions = true

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
	if p.InstallCompletions {
		fmt.Println("  • Install shell completions (worktree + wt)")
	}
	if p.ConfigureJira {
		fmt.Println("  • Configure Jira integration (optional)")
	}
	if p.TestJira {
		fmt.Println("  • Test Jira connection")
	}
	if !p.CreateWorktreesBase && !p.InstallShellRC && !p.CreateConfig && !p.InstallCompletions && !p.ConfigureJira && !p.TestJira {
		fmt.Println("  Nothing to do — already set up.")
	}
	if p.GHMissing {
		fmt.Printf("\n  %s GitHub CLI (gh) is not installed. PR features will be unavailable.\n", ui.Yellow("!"))
		fmt.Printf("       Install: %s\n", ui.Bold("https://cli.github.com/"))
	} else if p.GHNotAuthenticated {
		fmt.Printf("\n  %s GitHub CLI (gh) is not authenticated. PR features will be unavailable.\n", ui.Yellow("!"))
		fmt.Printf("       Run: %s\n", ui.Bold("gh auth login"))
	}
}

func (p Plan) HasWork() bool {
	return p.CreateWorktreesBase || p.InstallShellRC || p.CreateConfig || p.InstallCompletions || p.ConfigureJira || p.TestJira
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

	if p.ConfigureJira {
		if err := promptAndSaveJira(p.ConfigPath, p.Cfg); err != nil {
			return fmt.Errorf("configuring Jira: %w", err)
		}
	}

	if p.TestJira {
		if err := testAndRepairJira(p.ConfigPath, p.Cfg); err != nil {
			return fmt.Errorf("testing Jira: %w", err)
		}
	}

	return nil
}

func testAndRepairJira(configPath string, cfg config.Config) error {
	fmt.Print("  Testing Jira connection... ")
	testCfg := config.JiraConfig{Host: cfg.Jira.Host, Email: cfg.Jira.Email, Token: cfg.Jira.Token}
	if err := testJiraConnection(testCfg); err == nil {
		fmt.Printf("%s\n", ui.Green("ok"))
		return nil
	} else {
		fmt.Printf("%s\n", ui.Red("failed"))
		fmt.Printf("    %v\n", err)
	}

	if !ui.Confirm("  Replace the Jira API token?") {
		return nil
	}

	fmt.Printf("  Create a token at: %s\n", ui.Bold("https://id.atlassian.com/manage-profile/security/api-tokens"))
	token := ui.PromptSecret("  New Jira API token")
	if token == "" {
		return nil
	}

	testCfg.Token = token
	fmt.Print("  Testing new token... ")
	if err := testJiraConnection(testCfg); err != nil {
		fmt.Printf("%s\n", ui.Red("failed"))
		fmt.Printf("    %v\n", err)
		return nil
	}
	fmt.Printf("%s\n", ui.Green("ok"))

	cfg.Jira.Token = token
	if err := writeConfig(configPath, cfg); err != nil {
		return err
	}
	fmt.Printf("  %s Updated %s\n", ui.Green("✓"), ui.ShortPath(configPath))
	return nil
}

func promptAndSaveConfig(configPath string, cfg config.Config) error {
	home, _ := os.UserHomeDir()
	defaultRoot := "~"
	if len(cfg.Search.Roots) > 0 {
		defaultRoot = shortenHome(cfg.Search.Roots[0], home)
	}

	fmt.Println()
	root := ui.PromptLineDefault("  Where do you clone git projects?", defaultRoot)
	cfg.Search.Roots = []string{config.ExpandHome(root)}

	wtBase := ui.PromptLineDefault("  Where should worktrees be created?", shortenHome(cfg.WorktreesBase, home))
	cfg.WorktreesBase = config.ExpandHome(wtBase)

	if err := writeConfig(configPath, cfg); err != nil {
		return err
	}
	fmt.Printf("  %s Created %s\n", ui.Green("✓"), ui.ShortPath(configPath))
	return nil
}

func promptAndSaveJira(configPath string, cfg config.Config) error {
	fmt.Println()
	fmt.Println(ui.Bold("Jira integration (optional — press Enter to skip):"))

	host := ui.PromptLineDefault("  Jira host (e.g. your-org.atlassian.net)", cfg.Jira.Host)
	if host == "" {
		fmt.Printf("  %s Skipped Jira configuration\n", ui.Dim("—"))
		return nil
	}

	email := ui.PromptLineDefault("  Jira email", cfg.Jira.Email)
	fmt.Printf("  Create a token at: %s\n", ui.Bold("https://id.atlassian.com/manage-profile/security/api-tokens"))
	var token string
	if cfg.Jira.Token != "" {
		newToken := ui.PromptSecret("  Jira API token (Enter to keep existing)")
		if newToken != "" {
			token = newToken
		} else {
			token = cfg.Jira.Token
		}
	} else {
		token = ui.PromptSecret("  Jira API token")
	}
	projectsStr := ui.PromptLine("  Jira project prefixes (comma-separated, e.g. MYPROJ,OTHER)")

	var projects []string
	for _, p := range strings.Split(projectsStr, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			projects = append(projects, p)
		}
	}

	if token != "" {
		fmt.Print("  Testing Jira connection... ")
		testCfg := config.JiraConfig{Host: host, Email: email, Token: token}
		if err := testJiraConnection(testCfg); err != nil {
			fmt.Printf("%s\n", ui.Red("failed"))
			fmt.Printf("    %v\n", err)
			if !ui.Confirm("  Save anyway?") {
				return nil
			}
		} else {
			fmt.Printf("%s\n", ui.Green("ok"))
		}
	}

	if len(projects) == 0 {
		fmt.Printf("  %s No projects configured — Jira detection will be disabled\n", ui.Yellow("!"))
		return nil
	}

	cfg.Jira.Host = host
	cfg.Jira.Email = email
	cfg.Jira.Token = token
	cfg.Jira.Projects = projects

	if err := writeConfig(configPath, cfg); err != nil {
		return err
	}
	fmt.Printf("  %s Configured Jira: %s (%s)\n", ui.Green("✓"), host, strings.Join(projects, ", "))
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
		Host     string   `yaml:"host,omitempty"`
		Email    string   `yaml:"email,omitempty"`
		Token    string   `yaml:"token,omitempty"`
		Projects []string `yaml:"projects,omitempty"`
	}

	type yamlConfig struct {
		WorktreesBase string `yaml:"worktrees_base"`
		Search        struct {
			Roots []string `yaml:"roots"`
			Depth int      `yaml:"depth"`
			Prune []string `yaml:"prune"`
		} `yaml:"search"`
		Editor string   `yaml:"editor,omitempty"`
		Jira   jiraYaml `yaml:"jira,omitempty"`
	}

	yc := yamlConfig{
		WorktreesBase: shortenHome(cfg.WorktreesBase, home),
		Editor:        cfg.Editor,
	}
	yc.Search.Roots = make([]string, len(cfg.Search.Roots))
	for i, r := range cfg.Search.Roots {
		yc.Search.Roots[i] = shortenHome(r, home)
	}
	yc.Search.Depth = cfg.Search.Depth
	yc.Search.Prune = cfg.Search.Prune

	if cfg.Jira.Host != "" {
		yc.Jira = jiraYaml{
			Host:     cfg.Jira.Host,
			Email:    cfg.Jira.Email,
			Token:    cfg.Jira.Token,
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

func testJiraConnection(cfg config.JiraConfig) error {
	client, err := jira.NewClient(cfg)
	if err != nil {
		return err
	}
	return client.TestConnection()
}
