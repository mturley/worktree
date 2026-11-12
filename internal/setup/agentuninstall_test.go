package setup

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/ui"
)

// planDataFields are Plan's fields that say how to do a step, not whether to.
var planDataFields = map[string]bool{"WorktreesBase": true, "ShellRC": true, "ConfigPath": true, "Cfg": true}

// planStepUninstall is the uninstall decision for every setup step: Mike's
// rule is that anything setup offers to set up, --uninstall removes. A new
// Plan field fails TestUninstallCoversEverySetupStep until it gets an entry
// here, and "preserved" means PreviewUninstall has a Preserve line for it.
var planStepUninstall = map[string]string{
	"CreateWorktreesBase":    "preserved: worktree data",
	"InstallShellRC":         "removed",
	"CreateConfig":           "preserved: the config holds credentials",
	"InstallCompletions":     "removed",
	"CompletionsExist":       "removed", // only rewords InstallCompletions' preview
	"ConfigureJiraProjects":  "preserved: kept in the config",
	"TestGitHubCreds":        "preserved: credentials in the watcher config",
	"TestSlackCreds":         "preserved: credentials in the watcher config",
	"TestJiraCreds":          "preserved: credentials in the watcher config",
	"ConfigureUI":            "removed", // certificates and remote access; the password stays in the config
	"SeedGitHubBotUsernames": "preserved: a setting in the watcher's config.yaml",
	"MacApp":                 "removed",
	"AgentSkills":            "removed",
}

func TestUninstallCoversEverySetupStep(t *testing.T) {
	t.Parallel()
	typ := reflect.TypeOf(Plan{})
	seen := map[string]bool{}
	for i := 0; i < typ.NumField(); i++ {
		name := typ.Field(i).Name
		seen[name] = true
		if planDataFields[name] {
			continue
		}
		decision, ok := planStepUninstall[name]
		if !ok {
			t.Errorf("Plan.%s has no uninstall decision: undo it in ExecuteUninstall or add a Preserve line, then record it in planStepUninstall", name)
			continue
		}
		if decision != "removed" && !strings.HasPrefix(decision, "preserved: ") {
			t.Errorf("Plan.%s: malformed decision %q", name, decision)
		}
	}
	for name := range planStepUninstall {
		if !seen[name] {
			t.Errorf("planStepUninstall names %s, which Plan no longer has", name)
		}
	}
}

// Serial: t.Setenv and captureStdout. Previewing is read-only, so it is safe
// to run for real; ExecuteUninstall is not (completions live under brew).
func TestPreviewUninstallListsEverything(t *testing.T) {
	f := newSkillsFixture(t)
	t.Setenv("HOME", f.home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("XDG_DATA_HOME", "")
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(f.home, "xdg"))
	configPath := filepath.Join(f.home, "config.yaml")
	mustWrite(t, configPath, "")
	delete(f.env, "CLAUDE_CONFIG_DIR")
	f.deps.Skills = defaultSkillDeps().Skills
	f.install(t, f.deps)

	authPath := config.WatcherAuthPath()
	mustWrite(t, authPath, "{}\n")
	out := captureStdout(t, func() { PreviewUninstall(DetectShellRC(), configPath) })
	for _, want := range []string{
		"Remove worktree's skills: ~/.local/share/worktree/skills",
		"Remove the link ~/.claude/skills/worktree",
		"Preserve worktree data (except its agent skills;",
		"Preserve config at",
		"Preserve credentials at " + ui.ShortPath(authPath),
	} {
		if !strings.Contains(out, want) {
			t.Errorf("preview lacks %q:\n%s", want, out)
		}
	}
	if _, err := os.Stat(authPath); err != nil {
		t.Errorf("previewing removed the credentials: %v", err)
	}
}

func TestUninstallPreservesWatcherAuth(t *testing.T) {
	f := newSkillsFixture(t)
	t.Setenv("HOME", f.home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(f.home, "xdg"))
	authPath := config.WatcherAuthPath()
	mustWrite(t, authPath, "{}\n")
	configPath := filepath.Join(f.home, "config.yaml")
	out := captureStdout(t, func() { PreviewUninstall(DetectShellRC(), configPath) })
	if !strings.Contains(out, "Preserve credentials at "+ui.ShortPath(authPath)) {
		t.Errorf("preview: %s", out)
	}
	captureStdout(t, func() { runAgentUninstall(agentUninstall{Skill: f.deps}) })
	if _, err := os.Stat(authPath); err != nil {
		t.Errorf("credentials file: %v", err)
	}
}

// Every Plan reports and previews its skills step.
func TestPlanUsesSkillPlan(t *testing.T) {
	if !(Plan{AgentSkills: skillPlan{Prompt: skillPromptKeep}}).HasWork() {
		t.Error("a skills prompt is not work")
	}
	if (Plan{}).HasWork() {
		t.Error("the zero Plan has work")
	}
	out := captureStdout(t, func() { Plan{AgentSkills: skillPlan{Prompt: skillPromptKeep}}.Preview() })
	if !strings.Contains(out, "Ask whether to keep worktree's skills for AI agents") {
		t.Errorf("preview: %q", out)
	}
}

func TestAgentUninstallEndToEnd(t *testing.T) {
	f := newSkillsFixture(t)
	otherCfg := filepath.Join(f.root, "config-b")
	mustWrite(t, filepath.Join(otherCfg, "skills", "other-skill", "SKILL.md"), "someone else's skill")
	f.install(t, f.deps)
	linkA := filepath.Join(f.cfgDir, "skills", "alpha")
	// Uninstall runs under another CLAUDE_CONFIG_DIR and still finds linkA.
	b := f.deps
	b.Getenv = func(k string) string {
		if k == "CLAUDE_CONFIG_DIR" {
			return otherCfg
		}
		return ""
	}
	u := agentUninstall{Skill: b}

	preview := captureStdout(t, func() { previewAgentUninstall(u) })
	for _, want := range []string{"Remove worktree's skills", ui.ShortPath(linkA)} {
		if !strings.Contains(preview, want) {
			t.Errorf("preview lacks %q:\n%s", want, preview)
		}
	}

	out := captureStdout(t, func() { runAgentUninstall(u) })
	if strings.Contains(out, "!") {
		t.Errorf("output: %q", out)
	}
	for _, p := range append(append([]string{f.store()}, f.links("alpha")...), f.links("beta")...) {
		if lexists(p) {
			t.Errorf("%s survived", p)
		}
	}
	f.assertSiblingsSurvive(t)

	// Running it again finds nothing and changes nothing.
	again := captureStdout(t, func() { runAgentUninstall(u) })
	if strings.Contains(again, "✓") || strings.Contains(again, "!") {
		t.Errorf("second run: %q", again)
	}
}
