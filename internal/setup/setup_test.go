package setup

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/watcher/credsetup"
	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/ui"
)

// TestPromptAndSaveConfigDefaultsEditor verifies a newly created config.yaml
// names an editor (code), while one already chosen is kept.
func TestPromptAndSaveConfigDefaultsEditor(t *testing.T) {
	ui.SetNonInteractive(true)
	t.Cleanup(func() { ui.SetNonInteractive(false) })

	for _, tc := range []struct{ editor, want string }{{"", "editor: code"}, {"vim", "editor: vim"}} {
		path := filepath.Join(t.TempDir(), "config.yaml")
		cfg := config.DefaultConfig()
		cfg.Editor = tc.editor
		if err := promptAndSaveConfig(path, cfg); err != nil {
			t.Fatalf("promptAndSaveConfig: %v", err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), tc.want+"\n") {
			t.Errorf("editor %q: config.yaml = %q, want a line %q", tc.editor, data, tc.want)
		}
	}
}

// TestBuildPlanJiraCredsAlwaysTested verifies Jira credentials are tested
// (and repaired if needed) via the shared credsetup flow every run, exactly
// like GitHub and Slack — see testAndRepairWatcherCreds.
func TestBuildPlanJiraCredsAlwaysTested(t *testing.T) {
	for _, projects := range [][]string{nil, {"RHOAIENG"}} {
		cfg := config.DefaultConfig()
		cfg.Jira.Projects = projects
		plan := BuildPlan(cfg)
		if !plan.TestJiraCreds {
			t.Fatalf("TestJiraCreds should always be true (projects=%v)", projects)
		}
	}
}

// TestBuildPlanConfigureJiraProjects verifies ConfigureJiraProjects is only
// set when no project prefixes are configured yet — it is independent of
// Jira credential state (Projects has no watcher/credsetup equivalent).
func TestBuildPlanConfigureJiraProjects(t *testing.T) {
	cfg := config.DefaultConfig()
	plan := BuildPlan(cfg)
	if !plan.ConfigureJiraProjects {
		t.Fatal("expected ConfigureJiraProjects=true when Projects is empty")
	}

	cfg.Jira.Projects = []string{"RHOAIENG"}
	plan = BuildPlan(cfg)
	if plan.ConfigureJiraProjects {
		t.Fatal("expected ConfigureJiraProjects=false when Projects is already configured")
	}
}

// preservedConfig holds every kind of key a setup write must leave alone.
const preservedConfig = `# keep this comment
worktrees_base: ~/wt
custom_key: keep-me
github:
    bot_usernames:
        - gh-bot
jira:
    bot_usernames:
        - jira-bot
    custom_fields:
        story_points: customfield_1
    alias_hosts:
        - issues.example.com
notifications:
    disabled: true
git:
    fetch_interval: 10m
`

// assertPreserved fails unless every key of preservedConfig survived.
func assertPreserved(t *testing.T, path string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"# keep this comment", "custom_key: keep-me", "worktrees_base: ~/wt"} {
		if !strings.Contains(string(data), want) {
			t.Errorf("lost %q:\n%s", want, data)
		}
	}
	e, _, err := config.ReadEditable(path)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(e.GitHubBotUsernames, []string{"gh-bot"}) ||
		!slices.Equal(e.JiraBotUsernames, []string{"jira-bot"}) ||
		e.JiraCustomFields["story_points"] != "customfield_1" ||
		!slices.Equal(e.JiraAliasHosts, []string{"issues.example.com"}) ||
		!e.NotificationsDisabled || e.FetchInterval != "10m" {
		t.Errorf("watcher preferences or other keys lost:\n%s", data)
	}
}

// Serial: ui.SetNonInteractive is package-level state.
func TestPromptAndSaveJiraProjectsKeepsOtherKeys(t *testing.T) {
	ui.SetNonInteractive(true)
	t.Cleanup(func() { ui.SetNonInteractive(false) })
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(preservedConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := config.DefaultConfig()
	cfg.Jira.Projects = []string{"NEW"} // the non-interactive answer
	captureStdout(t, func() {
		if err := promptAndSaveJiraProjects(path, cfg); err != nil {
			t.Fatal(err)
		}
	})
	assertPreserved(t, path)
	e, _, _ := config.ReadEditable(path)
	if !slices.Equal(e.JiraProjects, []string{"NEW"}) {
		t.Fatalf("jira.projects = %v, want [NEW]", e.JiraProjects)
	}
}

// Serial: t.Setenv and a package-level seam.
func TestTestAndRepairSavesToWatcherAuth(t *testing.T) {
	xdg := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", xdg)
	orig := watcherTestAndRepair
	t.Cleanup(func() { watcherTestAndRepair = orig })
	watcherTestAndRepair = func(cfg *wconfig.Config, _ credsetup.Service, _ credsetup.Prompter) (bool, error) {
		cfg.Services.Slack = &wconfig.SlackConfig{Token: "t", Cookie: "c"}
		return true, nil
	}

	captureStdout(t, func() {
		if err := testAndRepairWatcherCreds(false, true, false); err != nil {
			t.Fatal(err)
		}
	})

	path := filepath.Join(xdg, "worktree", "watcher-auth.yaml")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", info.Mode().Perm())
	}
	saved, err := wconfig.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Services.Slack == nil || saved.Services.Slack.Token != "t" {
		t.Errorf("saved config lacks the credentials: %+v", saved.Services)
	}
}
