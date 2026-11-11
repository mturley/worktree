package setup

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	wconfig "github.com/mturley/watcher/config"
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
	t.Setenv("WATCHER_HOME", filepath.Join(f.home, "watcher"))
	configPath := filepath.Join(f.home, "config.yaml")
	mustWrite(t, configPath, "")
	delete(f.env, "CLAUDE_CONFIG_DIR")
	f.deps.Skills = defaultSkillDeps().Skills
	f.install(t, f.deps)

	writeWatcherConfig(t, filepath.Join(f.home, "watcher", "auth.yaml"), "worktree")
	mustWrite(t, filepath.Join(f.home, "watcher", "config.yaml"), "github:\n  bot_usernames: [\"*ci-bot*\"]\n")
	out := captureStdout(t, func() { PreviewUninstall(DetectShellRC(), configPath, "worktree") })
	for _, want := range []string{
		"Remove worktree's skills: ~/.local/share/worktree/skills",
		"Remove the link ~/.claude/skills/worktree",
		"• Unregister worktree's database from the watcher config",
		"Preserve worktree data (except its agent skills;",
		"Preserve config at",
		"Preserve credentials in the watcher config at",
		"Preserve watcher settings (such as GitHub bot usernames) at",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("preview lacks %q:\n%s", want, out)
		}
	}
	out = captureStdout(t, func() { PreviewUninstall(DetectShellRC(), configPath, "not-registered") })
	if strings.Contains(out, "Unregister") {
		t.Errorf("preview offers to unregister a consumer that isn't registered:\n%s", out)
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

func writeWatcherConfig(t *testing.T, path string, consumers ...string) {
	t.Helper()
	cfg := &wconfig.Config{}
	for _, c := range consumers {
		cfg.RegisterConsumer(c, "/some/"+c+".db")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := cfg.Save(path); err != nil {
		t.Fatal(err)
	}
}

func consumersIn(t *testing.T, path string) map[string]string {
	t.Helper()
	cfg, err := wconfig.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	return cfg.Consumers()
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
	watcher := filepath.Join(f.home, "watcher", "auth.yaml")
	writeWatcherConfig(t, watcher, "worktree", "agent-handler")
	u := agentUninstall{Skill: b, WatcherPath: watcher, Consumer: "worktree"}

	preview := captureStdout(t, func() { previewAgentUninstall(u) })
	for _, want := range []string{"Remove worktree's skills", ui.ShortPath(linkA), "Unregister worktree's database"} {
		if !strings.Contains(preview, want) {
			t.Errorf("preview lacks %q:\n%s", want, preview)
		}
	}

	out := captureStdout(t, func() { runAgentUninstall(u) })
	if !strings.Contains(out, "Unregistered worktree's database") {
		t.Errorf("output: %q", out)
	}
	for _, p := range append(append([]string{f.store()}, f.links("alpha")...), f.links("beta")...) {
		if lexists(p) {
			t.Errorf("%s survived", p)
		}
	}
	consumers := consumersIn(t, watcher)
	if _, ok := consumers["worktree"]; ok {
		t.Error("worktree is still registered")
	}
	if consumers["agent-handler"] != "/some/agent-handler.db" {
		t.Errorf("the other consumer was lost: %v", consumers)
	}
	f.assertSiblingsSurvive(t)

	// Running it again finds nothing and changes nothing.
	again := captureStdout(t, func() { runAgentUninstall(u) })
	if strings.Contains(again, "✓") || strings.Contains(again, "!") {
		t.Errorf("second run: %q", again)
	}
}

func TestAgentUninstallWatcherFailureStillRemovesSkill(t *testing.T) {
	f := newSkillsFixture(t)
	f.install(t, f.deps)
	watcher := filepath.Join(f.home, "auth.yaml")
	if err := os.WriteFile(watcher, []byte("{not yaml"), 0o600); err != nil {
		t.Fatal(err)
	}
	u := agentUninstall{Skill: f.deps, WatcherPath: watcher, Consumer: "worktree"}
	if preview := captureStdout(t, func() { previewAgentUninstall(u) }); !strings.Contains(preview, "Unregister") {
		t.Errorf("preview hides the unreadable config: %q", preview)
	}
	out := captureStdout(t, func() { runAgentUninstall(u) })
	if !strings.Contains(out, "Unregistering from the watcher config") {
		t.Errorf("no warning: %q", out)
	}
	if lexists(f.store()) {
		t.Error("the skills survived a watcher failure")
	}
}

func TestAgentUninstallSkillFailureStillUnregisters(t *testing.T) {
	f := newSkillsFixture(t)
	f.install(t, f.deps)
	// A read-only parent makes removing a link fail.
	parent := filepath.Join(f.home, ".claude", "skills")
	if err := os.Chmod(parent, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(parent, 0o755) })
	watcher := filepath.Join(f.home, "auth.yaml")
	writeWatcherConfig(t, watcher, "worktree")
	out := captureStdout(t, func() {
		runAgentUninstall(agentUninstall{Skill: f.deps, WatcherPath: watcher, Consumer: "worktree"})
	})
	if !strings.Contains(out, "Removing worktree's skills") {
		t.Errorf("no warning: %q", out)
	}
	if _, ok := consumersIn(t, watcher)["worktree"]; ok {
		t.Error("a skill failure stopped the unregister")
	}
}

// Uninstall must not create a credentials file that wasn't there.
func TestUnregisterWatcherConsumerNoFile(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "sub", "auth.yaml")
	if reg, err := watcherConsumerRegistered(path, "worktree"); err != nil || reg {
		t.Errorf("registered = %v, %v", reg, err)
	}
	if removed, err := unregisterWatcherConsumer(path, "worktree"); err != nil || removed {
		t.Fatalf("removed = %v, %v", removed, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("created a file: %v", err)
	}
}

// Nothing registered means nothing to change, so the file isn't rewritten.
func TestUnregisterWatcherConsumerNotRegisteredLeavesFile(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "auth.yaml")
	const original = "# a comment Save would drop\n"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := unregisterWatcherConsumer(path, "worktree"); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(path); string(data) != original {
		t.Errorf("file rewritten: %q", data)
	}
}
