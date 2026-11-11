package setup

import (
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/agentskill"
	"github.com/mturley/worktree/internal/ui"
)

// fakeSkills are what tests ship instead of the real embedded skills, so a
// "release" can add, drop or rename one.
var fakeSkills = map[string]agentskill.Skill{
	"alpha": {Name: "alpha", Files: map[string][]byte{
		"SKILL.md":  []byte("---\nname: alpha\n---\nA\n"),
		"refs/a.md": []byte("alpha reference\n"),
	}},
	"beta":  {Name: "beta", Files: map[string][]byte{"SKILL.md": []byte("---\nname: beta\n---\nB\n")}},
	"gamma": {Name: "gamma", Files: map[string][]byte{"SKILL.md": []byte("---\nname: gamma\n---\nG\n")}},
}

func withSkills(d skillDeps, names ...string) skillDeps {
	d.Skills = nil
	for _, n := range names {
		d.Skills = append(d.Skills, fakeSkills[n])
	}
	return d
}

// skillsFixture is a temp HOME whose three skills directories (~/.agents,
// ~/.claude and a CLAUDE_CONFIG_DIR) each already hold another tool's skill.
type skillsFixture struct {
	root, home, cfgDir string
	env                map[string]string
	answer             bool
	prompts            []string
	deps               skillDeps
}

func newSkillsFixture(t *testing.T) *skillsFixture {
	t.Helper()
	// EvalSymlinks: macOS's TempDir is itself under a symlink.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &skillsFixture{
		root:   root,
		home:   filepath.Join(root, "home"),
		cfgDir: filepath.Join(root, "claude-config"),
		answer: true,
	}
	f.env = map[string]string{"CLAUDE_CONFIG_DIR": f.cfgDir}
	for _, d := range f.dirs() {
		mustWrite(t, filepath.Join(d, "other-skill", "SKILL.md"), "someone else's skill")
	}
	f.deps = skillDeps{
		Home:     f.home,
		Getenv:   func(k string) string { return f.env[k] },
		Exists:   dirExists,
		Realpath: filepath.EvalSymlinks,
		Confirm: func(p string, def bool) bool {
			f.prompts = append(f.prompts, p)
			return f.answer
		},
		Skills: withSkills(skillDeps{}, "alpha", "beta").Skills,
	}
	return f
}

func (f *skillsFixture) store() string {
	return filepath.Join(f.home, ".local", "share", "worktree", "skills")
}

func (f *skillsFixture) dirs() []string {
	return []string{
		filepath.Join(f.home, ".agents", "skills"),
		filepath.Join(f.home, ".claude", "skills"),
		filepath.Join(f.cfgDir, "skills"),
	}
}

func (f *skillsFixture) links(name string) []string {
	var out []string
	for _, d := range f.dirs() {
		out = append(out, filepath.Join(d, name))
	}
	return out
}

func (f *skillsFixture) assertSiblingsSurvive(t *testing.T) {
	t.Helper()
	for _, d := range f.dirs() {
		data, err := os.ReadFile(filepath.Join(d, "other-skill", "SKILL.md"))
		if err != nil || string(data) != "someone else's skill" {
			t.Errorf("sibling skill in %s: %q, %v", d, data, err)
		}
	}
}

// install runs an interactive setup that accepts the offer.
func (f *skillsFixture) install(t *testing.T, d skillDeps) {
	t.Helper()
	p := detectSkills(d, false)
	if p.Prompt != skillPromptOffer {
		t.Fatalf("not offered: %+v", p)
	}
	if err := runSkillsStep(d, p); err != nil {
		t.Fatal(err)
	}
}

func uninstallSkills(t *testing.T, d skillDeps) {
	t.Helper()
	if err := applySkills(d, planSkillsUninstall(d)); err != nil {
		t.Fatal(err)
	}
}

// assertInstalled checks the store holds exactly names' files and every
// directory links each name to its store copy.
func (f *skillsFixture) assertInstalled(t *testing.T, names ...string) {
	t.Helper()
	entries, err := os.ReadDir(f.store())
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), ".") {
			got = append(got, e.Name())
		}
	}
	if !slices.Equal(got, names) {
		t.Errorf("store holds %v, want %v", got, names)
	}
	for _, n := range names {
		if !storeMatches(filepath.Join(f.store(), n), fakeSkills[n].Files) {
			t.Errorf("store copy of %s differs", n)
		}
		for _, l := range f.links(n) {
			if got := readlink(t, l); got != filepath.Join(f.store(), n) {
				t.Errorf("%s → %s", l, got)
			}
		}
	}
}

func noWork(p skillPlan) bool {
	return len(p.Write)+len(p.Prune)+len(p.Link)+len(p.Relink)+len(p.Unlink) == 0 && !p.RemoveStore
}

func TestOwnedTarget(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	store := f.store()
	mustWrite(t, filepath.Join(store, "alpha", "SKILL.md"), "x")
	dir := filepath.Join(f.root, "links")
	mustSymlink(t, filepath.Join(store, "alpha"), filepath.Join(dir, "abs"))
	rel, err := filepath.Rel(dir, filepath.Join(store, "alpha"))
	if err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, rel, filepath.Join(dir, "rel"))
	// The store reached through a symlinked parent.
	mustSymlink(t, filepath.Join(f.home, ".local", "share"), filepath.Join(f.root, "share-link"))
	mustSymlink(t, filepath.Join(f.root, "share-link", "worktree", "skills", "alpha"), filepath.Join(dir, "via-link"))
	mustSymlink(t, filepath.Join(store, "gone"), filepath.Join(dir, "dangling"))
	mustSymlink(t, filepath.Join(store, "alpha", "refs"), filepath.Join(dir, "deeper"))
	mustSymlink(t, filepath.Join(f.home, ".agents", "skills", "other-skill"), filepath.Join(dir, "foreign"))
	mustWrite(t, filepath.Join(dir, "realdir", "SKILL.md"), "x")
	mustWrite(t, filepath.Join(dir, "file"), "x")

	roots := storeRoots(store, filepath.EvalSymlinks)
	cases := []struct {
		entry, name string
		ok          bool
	}{
		{"abs", "alpha", true},
		{"rel", "alpha", true},
		{"via-link", "alpha", true},
		{"dangling", "gone", true},
		{"deeper", "", false},
		{"foreign", "", false},
		{"realdir", "", false},
		{"file", "", false},
		{"missing", "", false},
	}
	for _, c := range cases {
		name, ok := ownedTarget(filepath.Join(dir, c.entry), roots)
		if name != c.name || ok != c.ok {
			t.Errorf("%s: got (%q, %v), want (%q, %v)", c.entry, name, ok, c.name, c.ok)
		}
	}
}

func TestSkillsInstallThenUninstallLeavesNothing(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	f.install(t, f.deps)
	f.assertInstalled(t, "alpha", "beta")
	recorded := readLinkedDirs(f.store())
	if want := f.dirs(); !slices.Equal(recorded, sortedCopy(want)) {
		t.Errorf(".linked-dirs = %v, want %v", recorded, want)
	}

	again := detectSkills(f.deps, false)
	if again.Prompt != skillPromptKeep || !again.Keep || !noWork(again) {
		t.Errorf("second run: %+v", again)
	}

	un := planSkillsUninstall(f.deps)
	if !un.RemoveStore || len(un.Unlink) != 6 {
		t.Errorf("uninstall plan: %+v", un)
	}
	uninstallSkills(t, f.deps)
	if lexists(f.store()) {
		t.Error("store survived")
	}
	for _, n := range []string{"alpha", "beta"} {
		for _, l := range f.links(n) {
			if lexists(l) {
				t.Errorf("%s survived", l)
			}
		}
	}
	f.assertSiblingsSurvive(t)
	if p := planSkillsUninstall(f.deps); p.HasWork() {
		t.Errorf("uninstall again: %+v", p)
	}
}

func sortedCopy(s []string) []string {
	c := slices.Clone(s)
	sort.Strings(c)
	return c
}

func TestDeclinedOfferWritesNothing(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	f.answer = false
	if err := runSkillsStep(f.deps, detectSkills(f.deps, false)); err != nil {
		t.Fatal(err)
	}
	if lexists(f.store()) {
		t.Error("store created")
	}
	for _, l := range f.links("alpha") {
		if lexists(l) {
			t.Errorf("%s created", l)
		}
	}
	f.assertSiblingsSurvive(t)
}

func TestNonInteractiveNotInstalledInstallsNothing(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	p := detectSkills(f.deps, true)
	if p.Prompt != skillPromptNone || p.Keep || len(p.Write)+len(p.Link) != 0 || p.HasWork() {
		t.Errorf("plan: %+v", p)
	}
}

func TestNotInstalledStillRemovesOurDanglingLinks(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	for _, l := range f.links("alpha") {
		mustSymlink(t, filepath.Join(f.store(), "alpha"), l)
	}
	p := detectSkills(f.deps, true)
	if !slices.Equal(sortedCopy(p.Unlink), sortedCopy(f.links("alpha"))) {
		t.Errorf("Unlink = %v", p.Unlink)
	}
	if err := runSkillsStep(f.deps, p); err != nil {
		t.Fatal(err)
	}
	for _, l := range f.links("alpha") {
		if lexists(l) {
			t.Errorf("%s survived", l)
		}
	}
	f.assertSiblingsSurvive(t)
}

func TestInstalledAskedToKeep(t *testing.T) {
	t.Parallel()
	for _, nonInteractive := range []bool{false, true} {
		f := newSkillsFixture(t)
		f.install(t, f.deps)
		if p := detectSkills(f.deps, nonInteractive); p.Prompt != skillPromptKeep {
			t.Errorf("nonInteractive=%v: Prompt = %v", nonInteractive, p.Prompt)
		}
	}

	t.Run("declined", func(t *testing.T) {
		t.Parallel()
		f := newSkillsFixture(t)
		f.install(t, f.deps)
		f.answer = false
		f.prompts = nil
		if err := runSkillsStep(f.deps, detectSkills(f.deps, false)); err != nil {
			t.Fatal(err)
		}
		if want := []string{"Worktree's skills for AI agents are installed. Keep them?"}; !slices.Equal(f.prompts, want) {
			t.Errorf("prompts = %q", f.prompts)
		}
		if lexists(f.store()) {
			t.Error("store survived")
		}
		for _, n := range []string{"alpha", "beta"} {
			for _, l := range f.links(n) {
				if lexists(l) {
					t.Errorf("%s survived", l)
				}
			}
		}
		f.assertSiblingsSurvive(t)
	})

	t.Run("kept", func(t *testing.T) {
		t.Parallel()
		f := newSkillsFixture(t)
		f.install(t, f.deps)
		mustWrite(t, filepath.Join(f.store(), "alpha", "SKILL.md"), "edited")
		if err := runSkillsStep(f.deps, detectSkills(f.deps, false)); err != nil {
			t.Fatal(err)
		}
		f.assertInstalled(t, "alpha", "beta")
	})
}

// The keep and offer questions default to yes, so --yes keeps them.
func TestSkillPromptsDefaultYes(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	var defaults []bool
	f.deps.Confirm = func(p string, def bool) bool { defaults = append(defaults, def); return def }
	f.install(t, f.deps)
	if err := runSkillsStep(f.deps, detectSkills(f.deps, true)); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(defaults, []bool{true, true}) {
		t.Errorf("defaults = %v", defaults)
	}
	f.assertInstalled(t, "alpha", "beta")
}

func TestSyncRewritesChangedSkill(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	f.install(t, f.deps)
	mustWrite(t, filepath.Join(f.store(), "alpha", "SKILL.md"), "edited")
	mustWrite(t, filepath.Join(f.store(), "alpha", "extra.md"), "added by the user")
	p := detectSkills(f.deps, false)
	if !slices.Equal(p.Write, []string{"alpha"}) {
		t.Errorf("Write = %v", p.Write)
	}
	if err := runSkillsStep(f.deps, p); err != nil {
		t.Fatal(err)
	}
	f.assertInstalled(t, "alpha", "beta")
	if lexists(filepath.Join(f.store(), "alpha", "extra.md")) {
		t.Error("extra file survived")
	}
	entries, _ := os.ReadDir(f.store())
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".tmp-") {
			t.Errorf("left %s", e.Name())
		}
	}
}

func TestRemovedSkillIsPrunedAndUnlinked(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	f.install(t, f.deps)
	next := withSkills(f.deps, "alpha")
	p := detectSkills(next, false)
	if !slices.Equal(p.Prune, []string{"beta"}) || !slices.Equal(sortedCopy(p.Unlink), sortedCopy(f.links("beta"))) {
		t.Errorf("plan: %+v", p)
	}
	if err := runSkillsStep(next, p); err != nil {
		t.Fatal(err)
	}
	f.assertInstalled(t, "alpha")
	for _, l := range f.links("beta") {
		if lexists(l) {
			t.Errorf("%s survived", l)
		}
	}
	f.assertSiblingsSurvive(t)
}

func TestRenamedSkill(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	f.install(t, f.deps)
	next := withSkills(f.deps, "alpha", "gamma")
	if err := runSkillsStep(next, detectSkills(next, false)); err != nil {
		t.Fatal(err)
	}
	f.assertInstalled(t, "alpha", "gamma")
	for _, l := range f.links("beta") {
		if lexists(l) {
			t.Errorf("%s survived", l)
		}
	}
}

func TestRelinkWrongTarget(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	f.install(t, f.deps)
	link := filepath.Join(f.home, ".claude", "skills", "alpha")
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, filepath.Join(f.store(), "beta"), link)
	p := detectSkills(f.deps, false)
	if !slices.Equal(p.Relink, []string{link}) {
		t.Errorf("Relink = %v", p.Relink)
	}
	if err := runSkillsStep(f.deps, p); err != nil {
		t.Fatal(err)
	}
	f.assertInstalled(t, "alpha", "beta")
}

// Serial: captureStdout.
func TestUserEntryAtShippedName(t *testing.T) {
	f := newSkillsFixture(t)
	userDir := filepath.Join(f.home, ".claude", "skills", "alpha")
	mustWrite(t, filepath.Join(userDir, "SKILL.md"), "my own alpha")
	userLink := filepath.Join(f.home, ".agents", "skills", "beta")
	mustSymlink(t, filepath.Join(f.root, "elsewhere", "beta"), userLink)

	p := planSkills(f.deps, true)
	if !slices.Equal(sortedCopy(p.Conflicts), sortedCopy([]string{userDir, userLink})) {
		t.Errorf("Conflicts = %v", p.Conflicts)
	}
	if out := captureStdout(t, p.Preview); !strings.Contains(out, ui.ShortPath(userDir)+" exists and isn't worktree's; leaving it") {
		t.Errorf("preview: %q", out)
	}
	f.install(t, f.deps)
	assertUserEntries := func(when string) {
		t.Helper()
		if data, err := os.ReadFile(filepath.Join(userDir, "SKILL.md")); err != nil || string(data) != "my own alpha" {
			t.Errorf("%s: user dir: %q, %v", when, data, err)
		}
		if got := readlink(t, userLink); got != filepath.Join(f.root, "elsewhere", "beta") {
			t.Errorf("%s: user link → %s", when, got)
		}
	}
	assertUserEntries("after install")

	none := withSkills(f.deps)
	if err := runSkillsStep(none, detectSkills(none, false)); err != nil {
		t.Fatal(err)
	}
	assertUserEntries("after a release shipping nothing")
	uninstallSkills(t, none)
	assertUserEntries("after uninstall")
}

func TestForeignEntriesUntouched(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	cmux := filepath.Join(f.home, ".claude", "skills", "cmux")
	mustWrite(t, filepath.Join(f.home, ".agents", "skills", "cmux", "SKILL.md"), "cmux")
	mustSymlink(t, filepath.Join(f.home, ".agents", "skills", "cmux"), cmux)
	dangling := filepath.Join(f.home, ".claude", "skills", "old")
	mustSymlink(t, filepath.Join(f.root, "nowhere"), dangling)

	check := func(when string) {
		t.Helper()
		if !lexists(cmux) || !lexists(dangling) {
			t.Errorf("%s: a foreign link was removed", when)
		}
	}
	f.install(t, f.deps)
	check("install")
	none := withSkills(f.deps)
	if err := runSkillsStep(none, detectSkills(none, false)); err != nil {
		t.Fatal(err)
	}
	check("sync shipping nothing")
	uninstallSkills(t, f.deps)
	check("uninstall")
	f.assertSiblingsSurvive(t)
}

func TestSharedSkillsDirLinkedOnce(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	delete(f.env, "CLAUDE_CONFIG_DIR")
	claude := filepath.Join(f.home, ".claude", "skills")
	if err := os.RemoveAll(claude); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, filepath.Join(f.home, ".agents", "skills"), claude)

	p := planSkills(f.deps, true)
	f.install(t, f.deps)
	if len(p.Link) != 2 {
		t.Errorf("Link = %v, want one per skill", p.Link)
	}
	if got := readlink(t, filepath.Join(claude, "alpha")); got != filepath.Join(f.store(), "alpha") {
		t.Errorf("alpha → %s", got)
	}
	un := planSkillsUninstall(f.deps)
	if len(un.Unlink) != 2 {
		t.Errorf("Unlink = %v", un.Unlink)
	}
	uninstallSkills(t, f.deps)
	if lexists(filepath.Join(claude, "alpha")) {
		t.Error("link survived")
	}
}

func TestRecordedDirFromAnotherConfigDir(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	a := filepath.Join(f.root, "config-a")
	b := filepath.Join(f.root, "config-b")
	for _, d := range []string{a, b} {
		mustWrite(t, filepath.Join(d, "skills", "other-skill", "SKILL.md"), "someone else's skill")
	}
	withConfig := func(dir string) skillDeps {
		d := f.deps
		d.Getenv = func(k string) string {
			if k == "CLAUDE_CONFIG_DIR" {
				return dir
			}
			return ""
		}
		return d
	}
	dA, dB := withConfig(a), withConfig(b)
	f.install(t, dA)
	// A recorded directory that is gone later is ignored, not an error.
	gone := filepath.Join(f.root, "gone", "skills")
	if err := recordLinkedDirs(f.store(), []string{gone}); err != nil {
		t.Fatal(err)
	}

	next := withSkills(dB, "alpha", "beta", "gamma")
	if err := runSkillsStep(next, detectSkills(next, false)); err != nil {
		t.Fatal(err)
	}
	if got := readlink(t, filepath.Join(a, "skills", "gamma")); got != filepath.Join(f.store(), "gamma") {
		t.Errorf("gamma in A → %s", got)
	}
	if !slices.Contains(readLinkedDirs(f.store()), filepath.Join(a, "skills")) {
		t.Error("A's dir dropped from .linked-dirs")
	}

	uninstallSkills(t, dB)
	for _, n := range []string{"alpha", "beta", "gamma"} {
		for _, d := range []string{a, b} {
			if l := filepath.Join(d, "skills", n); lexists(l) {
				t.Errorf("%s survived", l)
			}
		}
	}
	if lexists(gone) {
		t.Error("created the gone directory")
	}
}

func TestStoreReachedThroughSymlink(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	data := filepath.Join(f.root, "data")
	if err := os.MkdirAll(data, 0o755); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, data, filepath.Join(f.root, "data-link"))
	f.env["XDG_DATA_HOME"] = filepath.Join(f.root, "data-link")
	f.install(t, f.deps)

	f.env["XDG_DATA_HOME"] = data
	p := detectSkills(f.deps, false)
	if !noWork(p) || len(p.Kept) != 6 {
		t.Errorf("plan: %+v", p)
	}
}

func TestSkillsUnknownHomeDoesNothing(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	d := f.deps
	d.Home = ""
	if p := detectSkills(d, false); p.HasWork() || p.Store != "" {
		t.Errorf("plan: %+v", p)
	}
	if err := runSkillsStep(d, detectSkills(d, false)); err != nil {
		t.Fatal(err)
	}
	uninstallSkills(t, d)
	if len(f.prompts) != 0 {
		t.Errorf("asked %q", f.prompts)
	}
	f.assertSiblingsSurvive(t)
}

// Serial: captureStdout.
func TestSkillsPreviewLines(t *testing.T) {
	store := "/s/skills"
	sh := ui.ShortPath
	cases := []struct {
		plan skillPlan
		want []string
	}{
		{skillPlan{Store: store, Prompt: skillPromptOffer}, []string{"• Offer to install worktree's skills for AI agents (" + sh(store) + ")"}},
		{skillPlan{Store: store, Prompt: skillPromptKeep}, []string{"• Ask whether to keep worktree's skills for AI agents (removes them if not)"}},
		{skillPlan{
			Store:       store,
			Write:       []string{"alpha"},
			Prune:       []string{"beta"},
			Link:        []string{"/d/skills/alpha"},
			Relink:      []string{"/e/skills/alpha"},
			Unlink:      []string{"/f/skills/beta"},
			Conflicts:   []string{"/g/skills/alpha"},
			RemoveStore: true,
		}, []string{
			"• Write the alpha skill",
			"• Remove the beta skill (no longer shipped)",
			"• Link the alpha skill into " + sh("/d/skills"),
			"• Re-point " + sh("/e/skills/alpha"),
			"• Remove the link " + sh("/f/skills/beta"),
			"— " + sh("/g/skills/alpha") + " exists and isn't worktree's; leaving it",
			"• Remove worktree's skills: " + sh(store),
		}},
	}
	for _, c := range cases {
		out := captureStdout(t, c.plan.Preview)
		last := -1
		for _, w := range c.want {
			i := strings.Index(out, w)
			if i < 0 {
				t.Errorf("preview lacks %q:\n%s", w, out)
				continue
			}
			if i < last {
				t.Errorf("%q out of order:\n%s", w, out)
			}
			last = i
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

// A link that can't be removed must stay findable: the store, and with it
// .linked-dirs, outlives a failed unlink so a re-run can finish the job.
func TestUninstallKeepsStoreWhenUnlinkFails(t *testing.T) {
	t.Parallel()
	f := newSkillsFixture(t)
	f.install(t, f.deps)
	parent := filepath.Join(f.cfgDir, "skills")
	if err := os.Chmod(parent, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(parent, 0o755) })
	// Uninstall from a run that doesn't see CLAUDE_CONFIG_DIR: only
	// .linked-dirs knows about parent.
	other := f.deps
	other.Getenv = func(string) string { return "" }
	if err := applySkills(other, planSkillsUninstall(other)); err == nil {
		t.Fatal("want the unlink error")
	}
	if !slices.Contains(readLinkedDirs(f.store()), parent) {
		t.Fatal("the store's record of the failed directory is gone")
	}
	if err := os.Chmod(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	uninstallSkills(t, other)
	if lexists(f.store()) {
		t.Error("store survived the re-run")
	}
	for _, l := range f.links("alpha") {
		if lexists(l) {
			t.Errorf("%s survived the re-run", l)
		}
	}
}
