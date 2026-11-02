package setup

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/worktree/internal/agentskill"
	"github.com/mturley/worktree/internal/ui"
)

func TestDecideAgentSkill(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name                              string
		installed                         bool
		installedHash, fileHash, embedded string
		nonInteractive                    bool
		want                              AgentSkillAction
	}{
		{"not installed, interactive", false, "", "", "new", false, AgentSkillOfferInstall},
		{"not installed, non-interactive", false, "", "", "new", true, AgentSkillNone},
		{"installed, current", true, "new", "new", "new", false, AgentSkillNone},
		{"installed, current, non-interactive", true, "new", "new", "new", true, AgentSkillNone},
		{"installed, stale", true, "old", "old", "new", false, AgentSkillUpdate},
		{"installed, stale, non-interactive", true, "old", "old", "new", true, AgentSkillUpdate},
		{"edited, stale", true, "old", "mine", "new", false, AgentSkillEditedSkip},
		{"edited, current", true, "new", "mine", "new", false, AgentSkillEditedSkip},
		{"edited, non-interactive", true, "old", "mine", "new", true, AgentSkillEditedSkip},
		{"SKILL.md deleted from our dir", true, "old", "", "new", false, AgentSkillEditedSkip},
		{"no hash file: not ours", true, "", "mine", "new", false, AgentSkillUserManaged},
		{"no hash file, non-interactive", true, "", "mine", "new", true, AgentSkillUserManaged},
		{"no hash file, content matches embedded", true, "", "new", "new", false, AgentSkillUserManaged},
	}
	for _, c := range cases {
		if got := decideAgentSkill(c.installed, c.installedHash, c.fileHash, c.embedded, c.nonInteractive); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

// skillFixture is a temp HOME with both Claude skill directories, each
// already holding another skill, and an explicit CLAUDE_CONFIG_DIR.
type skillFixture struct {
	home, canonical, homeLink, cfgLink string
	deps                               agentSkillDeps
}

func newSkillFixture(t *testing.T) skillFixture {
	t.Helper()
	// EvalSymlinks: macOS's TempDir is itself under a symlink.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(root, "home")
	cfgDir := filepath.Join(root, "claude-config")
	for _, d := range []string{
		filepath.Join(home, ".claude", "skills"),
		filepath.Join(cfgDir, "skills"),
		filepath.Join(home, ".agents", "skills"),
	} {
		mustWrite(t, filepath.Join(d, "other-skill", "SKILL.md"), "someone else's skill")
	}
	return skillFixture{
		home:      home,
		canonical: filepath.Join(home, ".agents", "skills", "worktree"),
		homeLink:  filepath.Join(home, ".claude", "skills", "worktree"),
		cfgLink:   filepath.Join(cfgDir, "skills", "worktree"),
		deps: agentSkillDeps{
			Home: home,
			Getenv: func(k string) string {
				if k == "CLAUDE_CONFIG_DIR" {
					return cfgDir
				}
				return ""
			},
			Exists:   dirExists,
			Realpath: filepath.EvalSymlinks,
			Confirm:  func(string, bool) bool { return true },
		},
	}
}

func (f skillFixture) assertSiblingsSurvive(t *testing.T) {
	t.Helper()
	for _, d := range []string{filepath.Dir(f.canonical), filepath.Dir(f.homeLink), filepath.Dir(f.cfgLink)} {
		data, err := os.ReadFile(filepath.Join(d, "other-skill", "SKILL.md"))
		if err != nil || string(data) != "someone else's skill" {
			t.Errorf("sibling skill in %s: %q, %v", d, data, err)
		}
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustSymlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

func lexists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

func readlink(t *testing.T, p string) string {
	t.Helper()
	got, err := os.Readlink(p)
	if err != nil {
		t.Fatalf("%s is not a symlink: %v", p, err)
	}
	return got
}

func TestInstallThenUninstallLeavesNothing(t *testing.T) {
	t.Parallel()
	f := newSkillFixture(t)

	if got := f.deps.action(false); got != AgentSkillOfferInstall {
		t.Fatalf("before install: action = %v", got)
	}
	if err := runAgentSkillStep(AgentSkillOfferInstall, f.deps); err != nil {
		t.Fatal(err)
	}

	got, err := os.ReadFile(filepath.Join(f.canonical, "SKILL.md"))
	if err != nil || string(got) != string(agentskill.Content) {
		t.Errorf("SKILL.md = %d bytes, %v", len(got), err)
	}
	hash, err := os.ReadFile(filepath.Join(f.canonical, agentSkillHashFile))
	if err != nil || string(hash) != agentskill.Hash() {
		t.Errorf("hash file = %q, %v", hash, err)
	}
	for _, link := range []string{f.homeLink, f.cfgLink} {
		if target := readlink(t, link); target != f.canonical {
			t.Errorf("%s -> %s, want %s", link, target, f.canonical)
		}
	}
	if got := f.deps.action(false); got != AgentSkillNone {
		t.Errorf("after install: action = %v", got)
	}

	if !PreviewAgentSkillUninstall(f.deps) {
		t.Error("preview found nothing")
	}
	if err := UninstallAgentSkill(f.deps); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{f.canonical, f.homeLink, f.cfgLink} {
		if lexists(p) {
			t.Errorf("%s still exists", p)
		}
	}
	f.assertSiblingsSurvive(t)
	if got := f.deps.action(false); got != AgentSkillOfferInstall {
		t.Errorf("after uninstall: action = %v", got)
	}
}

func TestInstallDeclinedWritesNothing(t *testing.T) {
	t.Parallel()
	f := newSkillFixture(t)
	var prompt string
	var defaultYes bool
	f.deps.Confirm = func(p string, d bool) bool { prompt, defaultYes = p, d; return false }
	if err := runAgentSkillStep(AgentSkillOfferInstall, f.deps); err != nil {
		t.Fatal(err)
	}
	if prompt != "Install the worktree skill for AI agents (Claude Code, Codex, pi…)?" || !defaultYes {
		t.Errorf("prompt %q, default yes = %v", prompt, defaultYes)
	}
	for _, p := range []string{f.canonical, f.homeLink, f.cfgLink} {
		if lexists(p) {
			t.Errorf("%s created after declining", p)
		}
	}
}

func TestInstallCreatesCanonicalParent(t *testing.T) {
	t.Parallel()
	f := newSkillFixture(t)
	if err := os.RemoveAll(filepath.Join(f.home, ".agents")); err != nil {
		t.Fatal(err)
	}
	if err := runAgentSkillStep(AgentSkillOfferInstall, f.deps); err != nil {
		t.Fatal(err)
	}
	if !lexists(filepath.Join(f.canonical, "SKILL.md")) {
		t.Error("SKILL.md not written")
	}
}

// Serial: t.Setenv, for the ~ in the notice, and captureStdout.
func TestInstallLeavesForeignEntry(t *testing.T) {
	cases := []struct {
		name  string
		place func(t *testing.T, path string)
		check func(t *testing.T, path string)
	}{
		{
			"real directory",
			func(t *testing.T, path string) { mustWrite(t, filepath.Join(path, "SKILL.md"), "mine") },
			func(t *testing.T, path string) {
				if data, err := os.ReadFile(filepath.Join(path, "SKILL.md")); err != nil || string(data) != "mine" {
					t.Errorf("SKILL.md = %q, %v", data, err)
				}
			},
		},
		{
			"symlink elsewhere",
			func(t *testing.T, path string) { mustSymlink(t, "/somewhere/else", path) },
			func(t *testing.T, path string) {
				if got := readlink(t, path); got != "/somewhere/else" {
					t.Errorf("link -> %s", got)
				}
			},
		},
		{
			"plain file",
			func(t *testing.T, path string) { mustWrite(t, path, "a file") },
			func(t *testing.T, path string) {
				if data, err := os.ReadFile(path); err != nil || string(data) != "a file" {
					t.Errorf("file = %q, %v", data, err)
				}
			},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newSkillFixture(t)
			t.Setenv("HOME", f.home)
			c.place(t, f.homeLink)
			var err error
			out := captureStdout(t, func() { err = runAgentSkillStep(AgentSkillOfferInstall, f.deps) })
			if err != nil {
				t.Fatal(err)
			}
			c.check(t, f.homeLink)
			if !strings.Contains(out, "~/.claude/skills/worktree exists and isn't worktree's; leaving it") {
				t.Errorf("no notice in %q", out)
			}
			// The other target still gets its link.
			if got := readlink(t, f.cfgLink); got != f.canonical {
				t.Errorf("config dir link -> %s", got)
			}
			if err := UninstallAgentSkill(f.deps); err != nil {
				t.Fatal(err)
			}
			c.check(t, f.homeLink)
		})
	}
}

func TestInstallKeepsOurExistingLinkQuietly(t *testing.T) {
	f := newSkillFixture(t)
	mustSymlink(t, f.canonical, f.homeLink) // e.g. the copy was deleted to get a new version
	var err error
	out := captureStdout(t, func() { err = runAgentSkillStep(AgentSkillOfferInstall, f.deps) })
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "leaving it") {
		t.Errorf("our own link reported as foreign: %q", out)
	}
	if got := readlink(t, f.homeLink); got != f.canonical {
		t.Errorf("link -> %s", got)
	}
}

// One real directory reached by two paths gets one link.
func TestInstallLinksSharedSkillsDirOnce(t *testing.T) {
	t.Parallel()
	f := newSkillFixture(t)
	cfgSkills := filepath.Dir(f.cfgLink)
	if err := os.RemoveAll(cfgSkills); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, filepath.Dir(f.homeLink), cfgSkills)
	if err := runAgentSkillStep(AgentSkillOfferInstall, f.deps); err != nil {
		t.Fatal(err)
	}
	if got := readlink(t, f.homeLink); got != f.canonical {
		t.Errorf("link -> %s", got)
	}
	if err := UninstallAgentSkill(f.deps); err != nil {
		t.Fatal(err)
	}
	if lexists(f.homeLink) {
		t.Error("link survived uninstall")
	}
}

func TestUninstallLeavesForeignSymlink(t *testing.T) {
	t.Parallel()
	f := newSkillFixture(t)
	if err := runAgentSkillStep(AgentSkillOfferInstall, f.deps); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(f.homeLink); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, "/somewhere/else", f.homeLink)
	if err := UninstallAgentSkill(f.deps); err != nil {
		t.Fatal(err)
	}
	if got := readlink(t, f.homeLink); got != "/somewhere/else" {
		t.Errorf("foreign link -> %s", got)
	}
	if lexists(f.canonical) || lexists(f.cfgLink) {
		t.Error("worktree's own pieces survived")
	}
	f.assertSiblingsSurvive(t)
}

func TestUpdateRewritesCopyAndHash(t *testing.T) {
	t.Parallel()
	f := newSkillFixture(t)
	old := "old skill"
	mustWrite(t, filepath.Join(f.canonical, "SKILL.md"), old)
	mustWrite(t, filepath.Join(f.canonical, agentSkillHashFile), hashBytes([]byte(old)))
	if got := f.deps.action(true); got != AgentSkillUpdate {
		t.Fatalf("action = %v", got)
	}
	f.deps.Confirm = func(string, bool) bool { t.Error("an update must not ask"); return false }
	if err := runAgentSkillStep(AgentSkillUpdate, f.deps); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(f.canonical, "SKILL.md")); string(data) != string(agentskill.Content) {
		t.Errorf("SKILL.md not updated: %q", data)
	}
	if data, _ := os.ReadFile(filepath.Join(f.canonical, agentSkillHashFile)); string(data) != agentskill.Hash() {
		t.Errorf("hash not updated: %q", data)
	}
	if got := f.deps.action(true); got != AgentSkillNone {
		t.Errorf("after update: action = %v", got)
	}
}

func TestEditedCopyIsNotUpdated(t *testing.T) {
	t.Parallel()
	f := newSkillFixture(t)
	mustWrite(t, filepath.Join(f.canonical, "SKILL.md"), "my edits")
	mustWrite(t, filepath.Join(f.canonical, agentSkillHashFile), hashBytes([]byte("old skill")))
	if got := f.deps.action(false); got != AgentSkillEditedSkip {
		t.Fatalf("action = %v", got)
	}
	if err := runAgentSkillStep(AgentSkillEditedSkip, f.deps); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(f.canonical, "SKILL.md")); string(data) != "my edits" {
		t.Errorf("SKILL.md = %q", data)
	}
}

func TestPreviewShowsSkillNotices(t *testing.T) {
	cases := []struct {
		action AgentSkillAction
		want   string
	}{
		{AgentSkillOfferInstall, "Offer to install the worktree skill"},
		{AgentSkillUpdate, "Update the worktree skill"},
		{AgentSkillEditedSkip, "skill edited; not updating (delete it to get the new version)"},
		{AgentSkillUserManaged, "isn't worktree's"},
	}
	for _, c := range cases {
		out := captureStdout(t, func() { Plan{AgentSkill: c.action}.Preview() })
		if !strings.Contains(out, c.want) {
			t.Errorf("%v: preview %q lacks %q", c.action, out, c.want)
		}
	}
}

func TestHasWorkForSkillActions(t *testing.T) {
	t.Parallel()
	for a, want := range map[AgentSkillAction]bool{
		AgentSkillNone: false, AgentSkillOfferInstall: true, AgentSkillUpdate: true,
		AgentSkillEditedSkip: false, AgentSkillUserManaged: false,
	} {
		if got := (Plan{AgentSkill: a}).HasWork(); got != want {
			t.Errorf("%v: HasWork = %v", a, got)
		}
	}
}

// Serial: captureStdout.
func TestUninstallRemovesEditedCopyAndPreviewSaysSo(t *testing.T) {
	f := newSkillFixture(t)
	if err := runAgentSkillStep(AgentSkillOfferInstall, f.deps); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(f.canonical, "SKILL.md"), "my edits")
	out := captureStdout(t, func() { PreviewAgentSkillUninstall(f.deps) })
	if !strings.Contains(out, "(edited)") {
		t.Errorf("preview %q does not say edited", out)
	}
	if err := UninstallAgentSkill(f.deps); err != nil {
		t.Fatal(err)
	}
	if lexists(f.canonical) {
		t.Error("edited copy survived")
	}
}

func TestPreviewUnedited(t *testing.T) {
	f := newSkillFixture(t)
	if err := runAgentSkillStep(AgentSkillOfferInstall, f.deps); err != nil {
		t.Fatal(err)
	}
	out := captureStdout(t, func() { PreviewAgentSkillUninstall(f.deps) })
	if strings.Contains(out, "(edited)") {
		t.Errorf("preview %q says edited", out)
	}
	for _, p := range []string{f.canonical, f.homeLink, f.cfgLink} {
		if !strings.Contains(out, ui.ShortPath(p)) {
			t.Errorf("preview %q lacks %s", out, p)
		}
	}
}

// Serial: captureStdout.
func TestUserManagedDirIsLeftAlone(t *testing.T) {
	cases := []struct {
		name  string
		place func(t *testing.T, f skillFixture) string
	}{
		{"directory with no hash file", func(t *testing.T, f skillFixture) string {
			mustWrite(t, filepath.Join(f.canonical, "SKILL.md"), "mine")
			return filepath.Join(f.canonical, "SKILL.md")
		}},
		{"symlink to a checkout, even one holding a hash file", func(t *testing.T, f skillFixture) string {
			checkout := filepath.Join(f.home, "checkout")
			mustWrite(t, filepath.Join(checkout, "SKILL.md"), "mine")
			mustWrite(t, filepath.Join(checkout, agentSkillHashFile), hashBytes([]byte("mine")))
			mustSymlink(t, checkout, f.canonical)
			return filepath.Join(checkout, "SKILL.md")
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newSkillFixture(t)
			skillMD := c.place(t, f)
			mustSymlink(t, f.canonical, f.homeLink) // the user's own link to it

			if got := f.deps.action(false); got != AgentSkillUserManaged {
				t.Fatalf("action = %v", got)
			}
			if err := runAgentSkillStep(AgentSkillUserManaged, f.deps); err != nil {
				t.Fatal(err)
			}
			preview := captureStdout(t, func() { PreviewAgentSkillUninstall(f.deps) })
			if !strings.Contains(preview, "isn't worktree's") || strings.Contains(preview, "Remove") {
				t.Errorf("preview = %q", preview)
			}
			var err error
			out := captureStdout(t, func() { err = UninstallAgentSkill(f.deps) })
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out, "isn't worktree's") {
				t.Errorf("uninstall did not say so: %q", out)
			}
			if data, err := os.ReadFile(skillMD); err != nil || string(data) != "mine" {
				t.Errorf("SKILL.md = %q, %v", data, err)
			}
			if !lexists(f.canonical) || !lexists(f.homeLink) {
				t.Error("user-managed skill or its link was removed")
			}
		})
	}
}

// The user deleted the copy to get a new version, leaving our link dangling.
func TestUninstallRemovesOurDanglingLink(t *testing.T) {
	t.Parallel()
	f := newSkillFixture(t)
	mustSymlink(t, f.canonical, f.homeLink)
	if !PreviewAgentSkillUninstall(f.deps) {
		t.Error("preview found nothing")
	}
	if err := UninstallAgentSkill(f.deps); err != nil {
		t.Fatal(err)
	}
	if lexists(f.homeLink) {
		t.Error("dangling link survived")
	}
}

func TestUninstallNothingInstalled(t *testing.T) {
	t.Parallel()
	f := newSkillFixture(t)
	if PreviewAgentSkillUninstall(f.deps) {
		t.Error("preview found something")
	}
	if err := UninstallAgentSkill(f.deps); err != nil {
		t.Fatal(err)
	}
	f.assertSiblingsSurvive(t)
}

// With no home directory the paths would be relative to the working
// directory, so nothing may happen at all.
func TestUnknownHomeDoesNothing(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	mustWrite(t, filepath.Join(dir, ".agents", "skills", "worktree", "SKILL.md"), "x")
	mustWrite(t, filepath.Join(dir, ".agents", "skills", "worktree", agentSkillHashFile), hashBytes([]byte("x")))
	d := newSkillFixture(t).deps
	d.Home = ""
	if got := d.action(false); got != AgentSkillNone {
		t.Errorf("action = %v", got)
	}
	if PreviewAgentSkillUninstall(d) {
		t.Error("preview found something")
	}
	if err := UninstallAgentSkill(d); err != nil {
		t.Fatal(err)
	}
	if err := runAgentSkillStep(AgentSkillOfferInstall, d); err != nil {
		t.Fatal(err)
	}
	if !lexists(filepath.Join(dir, ".agents", "skills", "worktree", "SKILL.md")) {
		t.Error("removed a relative path")
	}
}

// planDataFields are Plan's fields that say how to do a step, not whether to.
var planDataFields = map[string]bool{"WorktreesBase": true, "ShellRC": true, "ConfigPath": true, "Cfg": true}

// planStepUninstall is the uninstall decision for every setup step: Mike's
// rule is that anything setup offers to set up, --uninstall removes. A new
// Plan field fails TestUninstallCoversEverySetupStep until it gets an entry
// here, and "preserved" means PreviewUninstall has a Preserve line for it.
var planStepUninstall = map[string]string{
	"CreateWorktreesBase":   "preserved: worktree data",
	"InstallShellRC":        "removed",
	"CreateConfig":          "preserved: the config holds credentials",
	"InstallCompletions":    "removed",
	"CompletionsExist":      "removed", // only rewords InstallCompletions' preview
	"ConfigureJiraProjects": "preserved: kept in the config",
	"TestGitHubCreds":       "preserved: credentials in the watcher config",
	"TestSlackCreds":        "preserved: credentials in the watcher config",
	"TestJiraCreds":         "preserved: credentials in the watcher config",
	"ConfigureUI":           "removed", // certificates and remote access; the password stays in the config
	"MacApp":                "removed",
	"AgentSkill":            "removed",
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
	f := newSkillFixture(t)
	t.Setenv("HOME", f.home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("WATCHER_HOME", filepath.Join(f.home, "watcher"))
	configPath := filepath.Join(f.home, "config.yaml")
	mustWrite(t, configPath, "")
	if err := runAgentSkillStep(AgentSkillOfferInstall, f.deps); err != nil {
		t.Fatal(err)
	}

	writeWatcherConfig(t, filepath.Join(f.home, "watcher", "auth.yaml"), "worktree")
	out := captureStdout(t, func() { PreviewUninstall(DetectShellRC(), configPath, "worktree") })
	for _, want := range []string{
		"Remove the worktree skill: ~/.agents/skills/worktree",
		"Remove its symlink: ~/.claude/skills/worktree",
		"• Unregister worktree's database from the watcher config",
		"Preserve worktree data",
		"Preserve config at",
		"Preserve credentials in the watcher config at",
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

// twoConfigDirs is a fixture whose CLAUDE_CONFIG_DIR differs between runs, as
// it does for someone running two Claude environments. /a and /b are both
// under the temp HOME, and each already holds a sibling skill.
func twoConfigDirs(t *testing.T) (f skillFixture, a, b agentSkillDeps, linkA string) {
	t.Helper()
	f = newSkillFixture(t)
	withConfigDir := func(name string) agentSkillDeps {
		dir := filepath.Join(f.home, name)
		mustWrite(t, filepath.Join(dir, "skills", "other-skill", "SKILL.md"), "someone else's skill")
		d := f.deps
		d.Getenv = func(k string) string {
			if k == "CLAUDE_CONFIG_DIR" {
				return dir
			}
			return ""
		}
		return d
	}
	return f, withConfigDir("a"), withConfigDir("b"), filepath.Join(f.home, "a", "skills", "worktree")
}

func TestUninstallRemovesLinksFromAnotherConfigDir(t *testing.T) {
	f, a, b, linkA := twoConfigDirs(t)
	if err := runAgentSkillStep(AgentSkillOfferInstall, a); err != nil {
		t.Fatal(err)
	}
	if got := readlink(t, linkA); got != f.canonical {
		t.Fatalf("link -> %s", got)
	}

	preview := captureStdout(t, func() { PreviewAgentSkillUninstall(b) })
	if !strings.Contains(preview, ui.ShortPath(linkA)) {
		t.Errorf("preview does not list %s:\n%s", linkA, preview)
	}
	if err := UninstallAgentSkill(b); err != nil {
		t.Fatal(err)
	}
	if lexists(linkA) {
		t.Error("the link in the other config dir survived")
	}
	if lexists(f.canonical) {
		t.Error("the canonical dir survived")
	}
	data, err := os.ReadFile(filepath.Join(f.home, "a", "skills", "other-skill", "SKILL.md"))
	if err != nil || string(data) != "someone else's skill" {
		t.Errorf("sibling skill in /a/skills: %q, %v", data, err)
	}
}

func TestUninstallLeavesForeignSymlinkAtRecordedPath(t *testing.T) {
	f, a, b, linkA := twoConfigDirs(t)
	if err := runAgentSkillStep(AgentSkillOfferInstall, a); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(linkA); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, "/somewhere/else", linkA)
	if err := UninstallAgentSkill(b); err != nil {
		t.Fatal(err)
	}
	if got := readlink(t, linkA); got != "/somewhere/else" {
		t.Errorf("foreign link -> %s", got)
	}
	if lexists(f.canonical) {
		t.Error("the canonical dir survived")
	}
}

func TestManifestRecordsEachLinkOnceAndIsNotHashed(t *testing.T) {
	t.Parallel()
	f, a, b, linkA := twoConfigDirs(t)
	for _, d := range []agentSkillDeps{a, a, b} {
		if err := runAgentSkillStep(AgentSkillOfferInstall, d); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(filepath.Join(f.canonical, agentSkillLinksFile))
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Join([]string{linkA, f.homeLink, filepath.Join(f.home, "b", "skills", "worktree")}, "\n") + "\n"
	if string(data) != want {
		t.Errorf("manifest:\n%s\nwant:\n%s", data, want)
	}
	if got := a.action(false); got != AgentSkillNone {
		t.Errorf("the manifest changed the action: %v", got)
	}
}

func TestUpdateKeepsManifest(t *testing.T) {
	t.Parallel()
	f, a, b, linkA := twoConfigDirs(t)
	if err := runAgentSkillStep(AgentSkillOfferInstall, a); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(f.canonical, "SKILL.md"), "old")
	mustWrite(t, filepath.Join(f.canonical, agentSkillHashFile), hashBytes([]byte("old")))
	if err := runAgentSkillStep(AgentSkillUpdate, b); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(readAgentSkillLinks(f.canonical), linkA) {
		t.Error("the update lost the recorded link")
	}
}

// A bad manifest falls back to Targets, and must not fail uninstall.
func TestUninstallSurvivesBadManifest(t *testing.T) {
	cases := []struct {
		name  string
		spoil func(t *testing.T, manifest string)
	}{
		{"missing", func(t *testing.T, m string) {
			if err := os.Remove(m); err != nil {
				t.Fatal(err)
			}
		}},
		{"malformed", func(t *testing.T, m string) { mustWrite(t, m, "relative/path\n\n\x00\xff garbage\n") }},
		{"a directory", func(t *testing.T, m string) {
			if err := os.Remove(m); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(m, 0o755); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newSkillFixture(t)
			if err := runAgentSkillStep(AgentSkillOfferInstall, f.deps); err != nil {
				t.Fatal(err)
			}
			c.spoil(t, filepath.Join(f.canonical, agentSkillLinksFile))
			if err := UninstallAgentSkill(f.deps); err != nil {
				t.Fatal(err)
			}
			for _, p := range []string{f.canonical, f.homeLink, f.cfgLink} {
				if lexists(p) {
					t.Errorf("%s survived", p)
				}
			}
			f.assertSiblingsSurvive(t)
		})
	}
}

// Two recorded paths to one link, through a shared skills directory: the
// second removal must not fail on a link the first already removed.
func TestUninstallRemovesSharedLinkOnce(t *testing.T) {
	t.Parallel()
	f := newSkillFixture(t)
	if err := runAgentSkillStep(AgentSkillOfferInstall, f.deps); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(f.home, "alias-skills")
	mustSymlink(t, filepath.Dir(f.homeLink), alias)
	if err := recordAgentSkillLink(f.canonical, filepath.Join(alias, "worktree")); err != nil {
		t.Fatal(err)
	}
	if err := UninstallAgentSkill(f.deps); err != nil {
		t.Fatal(err)
	}
	if lexists(f.homeLink) {
		t.Error("link survived")
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
	f, a, b, linkA := twoConfigDirs(t)
	if err := runAgentSkillStep(AgentSkillOfferInstall, a); err != nil {
		t.Fatal(err)
	}
	watcher := filepath.Join(f.home, "watcher", "auth.yaml")
	writeWatcherConfig(t, watcher, "worktree", "agent-handler")
	u := agentUninstall{Skill: b, WatcherPath: watcher, Consumer: "worktree"}

	preview := captureStdout(t, func() { previewAgentUninstall(u) })
	for _, want := range []string{"Remove the worktree skill", ui.ShortPath(linkA), "Unregister worktree's database"} {
		if !strings.Contains(preview, want) {
			t.Errorf("preview lacks %q:\n%s", want, preview)
		}
	}

	out := captureStdout(t, func() { runAgentUninstall(u) })
	if !strings.Contains(out, "Unregistered worktree's database") {
		t.Errorf("output: %q", out)
	}
	for _, p := range []string{f.canonical, linkA, f.homeLink} {
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
	f := newSkillFixture(t)
	if err := runAgentSkillStep(AgentSkillOfferInstall, f.deps); err != nil {
		t.Fatal(err)
	}
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
	if lexists(f.canonical) {
		t.Error("the skill survived a watcher failure")
	}
}

func TestAgentUninstallSkillFailureStillUnregisters(t *testing.T) {
	f := newSkillFixture(t)
	if err := runAgentSkillStep(AgentSkillOfferInstall, f.deps); err != nil {
		t.Fatal(err)
	}
	// A read-only parent makes removing the link fail.
	parent := filepath.Dir(f.homeLink)
	if err := os.Chmod(parent, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(parent, 0o755) })
	watcher := filepath.Join(f.home, "auth.yaml")
	writeWatcherConfig(t, watcher, "worktree")
	out := captureStdout(t, func() {
		runAgentUninstall(agentUninstall{Skill: f.deps, WatcherPath: watcher, Consumer: "worktree"})
	})
	if !strings.Contains(out, "Removing the worktree skill") {
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
