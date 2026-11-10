package setup

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/mturley/worktree/internal/agentskill"
	"github.com/mturley/worktree/internal/ui"
)

// Worktree's skills for AI agents live as real copies in a store worktree
// owns outright (agentskill.StoreDir), rewritten each run to exactly the
// skills this binary embeds. Every skills directory agents read gets a symlink
// per skill pointing straight into the store. An entry is worktree's if and
// only if it is a symlink whose target's parent is the store, which stays
// checkable after the target is gone: stale links are found by scanning,
// never by remembering old skill names. Nothing else is ever touched.

const (
	// linkedDirsFile, in the store, lists every skills directory setup has
	// linked into, so a link made under a CLAUDE_CONFIG_DIR that isn't set on
	// this run is still kept in step and removed on uninstall.
	linkedDirsFile = ".linked-dirs"
	// tmpPrefix names a skill being written; a crash can leave one behind.
	tmpPrefix = ".tmp-"

	skillOfferPrompt = "Install worktree's skills for AI agents (Claude Code, Codex, pi…)?"
	skillKeepPrompt  = "Worktree's skills for AI agents are installed. Keep them?"
)

type skillDeps struct {
	Home     string
	Getenv   func(string) string
	Exists   func(string) bool
	Realpath func(string) (string, error)
	Confirm  func(string, bool) bool
	// Skills is what this binary ships; tests pass their own.
	Skills []agentskill.Skill
}

func defaultSkillDeps() skillDeps {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "" // every step does nothing without a home directory
	}
	return skillDeps{
		Home:     home,
		Getenv:   os.Getenv,
		Exists:   dirExists,
		Realpath: filepath.EvalSymlinks,
		Confirm:  confirmDefault,
		Skills:   agentskill.Skills(),
	}
}

type skillPrompt int

const (
	skillPromptNone  skillPrompt = iota // not installed, non-interactive
	skillPromptOffer                    // not installed, interactive: offer to install
	skillPromptKeep                     // installed: ask whether to keep them
)

// skillPlan is what one run does. With a prompt, it is what happens on yes
// for skillPromptKeep, and on no for skillPromptOffer; runSkillsStep replans
// for the other answer.
type skillPlan struct {
	Store       string
	Prompt      skillPrompt
	Keep        bool     // the store stays and is synced
	Write       []string // skill names whose store copy is missing or differs
	Prune       []string // store skill names no longer shipped
	Link        []string // link paths to create
	Relink      []string // our links pointing at the wrong store entry
	Unlink      []string // our links to remove
	Kept        []string // our links already correct
	Conflicts   []string // a shipped name's path holds something not ours
	RemoveStore bool     // uninstall only
}

// storeRoots is every form of the store's path a link of ours may name: as
// written, resolved, and with only its parent resolved (the store itself may
// be gone).
func storeRoots(store string, realpath func(string) (string, error)) []string {
	roots := []string{filepath.Clean(store)}
	add := func(p string) {
		if !slices.Contains(roots, p) {
			roots = append(roots, p)
		}
	}
	if r, err := realpath(store); err == nil {
		add(r)
	}
	if r, err := realpath(filepath.Dir(store)); err == nil {
		add(filepath.Join(r, filepath.Base(store)))
	}
	return roots
}

// ownedTarget reports whether the entry at path is worktree's: a symlink whose
// target is directly inside the store. name is the target's base name. A
// dangling link counts; a link deeper into the store doesn't, since setup
// never makes one.
func ownedTarget(path string, roots []string) (name string, ok bool) {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&fs.ModeSymlink == 0 {
		return "", false
	}
	target, err := os.Readlink(path)
	if err != nil {
		return "", false
	}
	if !filepath.IsAbs(target) {
		// The OS resolves a relative target from the link's real directory.
		dir := filepath.Dir(path)
		if r, err := filepath.EvalSymlinks(dir); err == nil {
			dir = r
		}
		target = filepath.Join(dir, target)
	}
	target = filepath.Clean(target)
	parent := filepath.Dir(target)
	if slices.Contains(roots, parent) {
		return filepath.Base(target), true
	}
	// The link may name the store through a symlink the roots don't spell.
	if r, err := filepath.EvalSymlinks(parent); err == nil && slices.Contains(roots, r) {
		return filepath.Base(target), true
	}
	return "", false
}

// scanDirs is every skills directory to look in: SkillDirs, then the recorded
// ones that still exist, deduplicated by realpath.
func (d skillDeps) scanDirs(store string) []string {
	candidates := agentskill.SkillDirs(d.Home, d.Getenv, d.Exists, d.Realpath)
	for _, r := range readLinkedDirs(store) {
		if d.Exists(r) {
			candidates = append(candidates, r)
		}
	}
	seen := map[string]bool{}
	var dirs []string
	for _, dir := range candidates {
		key := dir
		if r, err := d.Realpath(dir); err == nil {
			key = r
		}
		if !seen[key] {
			seen[key] = true
			dirs = append(dirs, dir)
		}
	}
	return dirs
}

// planSkills works out a run that keeps the skills (keep) or one that leaves
// none of worktree's links behind. It changes nothing.
func planSkills(d skillDeps, keep bool) skillPlan {
	if d.Home == "" {
		return skillPlan{}
	}
	store := agentskill.StoreDir(d.Home, d.Getenv)
	p := skillPlan{Store: store, Keep: keep}
	roots := storeRoots(store, d.Realpath)
	shipped := map[string]bool{}
	for _, s := range d.Skills {
		shipped[s.Name] = true
	}

	for _, dir := range d.scanDirs(store) {
		entries, _ := os.ReadDir(dir) // missing or unreadable: nothing to scan
		present := map[string]bool{}
		for _, e := range entries {
			path := filepath.Join(dir, e.Name())
			present[e.Name()] = true
			target, ours := ownedTarget(path, roots)
			wanted := keep && shipped[e.Name()]
			switch {
			case !ours:
				if wanted {
					p.Conflicts = append(p.Conflicts, path)
				}
			case wanted && target == e.Name():
				p.Kept = append(p.Kept, path)
			case wanted:
				p.Relink = append(p.Relink, path)
			default:
				p.Unlink = append(p.Unlink, path)
			}
		}
		if keep {
			for _, s := range d.Skills {
				if !present[s.Name] {
					p.Link = append(p.Link, filepath.Join(dir, s.Name))
				}
			}
		}
	}

	if keep {
		for _, s := range d.Skills {
			if !storeMatches(filepath.Join(store, s.Name), s.Files) {
				p.Write = append(p.Write, s.Name)
			}
		}
		entries, _ := os.ReadDir(store)
		for _, e := range entries {
			if e.IsDir() && !strings.HasPrefix(e.Name(), ".") && !shipped[e.Name()] {
				p.Prune = append(p.Prune, e.Name())
			}
		}
	}
	return p
}

// detectSkills plans this run from what is installed: the store existing
// means the user agreed to the skills, and is asked whether to keep them.
func detectSkills(d skillDeps, nonInteractive bool) skillPlan {
	if d.Home == "" {
		return skillPlan{}
	}
	if dirExists(agentskill.StoreDir(d.Home, d.Getenv)) {
		p := planSkills(d, true)
		p.Prompt = skillPromptKeep
		return p
	}
	p := planSkills(d, false)
	if !nonInteractive {
		p.Prompt = skillPromptOffer
	}
	return p
}

// planSkillsUninstall removes every link of ours, then the store.
func planSkillsUninstall(d skillDeps) skillPlan {
	p := planSkills(d, false)
	if p.Store != "" {
		_, err := os.Lstat(p.Store)
		p.RemoveStore = err == nil
	}
	return p
}

func (p skillPlan) HasWork() bool {
	return p.Prompt != skillPromptNone || p.RemoveStore ||
		len(p.Write)+len(p.Prune)+len(p.Link)+len(p.Relink)+len(p.Unlink) > 0
}

func (p skillPlan) Preview() {
	switch p.Prompt {
	case skillPromptOffer:
		fmt.Printf("  • Offer to install worktree's skills for AI agents (%s)\n", ui.ShortPath(p.Store))
	case skillPromptKeep:
		fmt.Println("  • Ask whether to keep worktree's skills for AI agents (removes them if not)")
	}
	for _, n := range p.Write {
		fmt.Printf("  • Write the %s skill\n", n)
	}
	for _, n := range p.Prune {
		fmt.Printf("  • Remove the %s skill (no longer shipped)\n", n)
	}
	for _, l := range p.Link {
		fmt.Printf("  • Link the %s skill into %s\n", filepath.Base(l), ui.ShortPath(filepath.Dir(l)))
	}
	for _, l := range p.Relink {
		fmt.Printf("  • Re-point %s\n", ui.ShortPath(l))
	}
	for _, l := range p.Unlink {
		fmt.Printf("  • Remove the link %s\n", ui.ShortPath(l))
	}
	for _, l := range p.Conflicts {
		fmt.Printf("  %s\n", ui.Dim("— "+ui.ShortPath(l)+" exists and isn't worktree's; leaving it"))
	}
	if p.RemoveStore {
		fmt.Printf("  • Remove worktree's skills: %s\n", ui.ShortPath(p.Store))
	}
}

// runSkillsStep asks the plan's question, replans for a different answer,
// and applies the result.
func runSkillsStep(d skillDeps, p skillPlan) error {
	switch p.Prompt {
	case skillPromptOffer:
		if d.Confirm(skillOfferPrompt, true) {
			p = planSkills(d, true)
		}
	case skillPromptKeep:
		if !d.Confirm(skillKeepPrompt, true) {
			p = planSkillsUninstall(d)
		}
	}
	return applySkills(d, p)
}

// applySkills carries out p. A failed item doesn't stop the rest; every
// failure is returned.
func applySkills(d skillDeps, p skillPlan) error {
	if p.Store == "" {
		return nil
	}
	var errs []error
	fail := func(err error) {
		if err != nil {
			errs = append(errs, err)
		}
	}
	ok := func(format string, args ...any) {
		fmt.Printf("  %s %s\n", ui.Green("✓"), fmt.Sprintf(format, args...))
	}
	skills := map[string]agentskill.Skill{}
	for _, s := range d.Skills {
		skills[s.Name] = s
	}

	for _, n := range p.Write {
		if err := writeSkill(p.Store, skills[n]); err != nil {
			fail(fmt.Errorf("writing the %s skill: %w", n, err))
			continue
		}
		ok("Wrote the %s skill", n)
	}
	if p.Keep {
		removeTmpSkills(p.Store)
	}
	for _, n := range p.Prune {
		if err := os.RemoveAll(filepath.Join(p.Store, n)); err != nil {
			fail(fmt.Errorf("removing the %s skill: %w", n, err))
			continue
		}
		ok("Removed the %s skill", n)
	}
	unlinkFailed := false
	for _, l := range p.Unlink {
		if err := os.Remove(l); err != nil {
			unlinkFailed = true
			fail(fmt.Errorf("removing %s: %w", l, err))
			continue
		}
		ok("Removed the link %s", ui.ShortPath(l))
	}
	var linked []string
	for _, l := range p.Relink {
		if err := os.Remove(l); err != nil {
			fail(fmt.Errorf("re-pointing %s: %w", l, err))
			continue
		}
		if err := os.Symlink(filepath.Join(p.Store, filepath.Base(l)), l); err != nil {
			fail(fmt.Errorf("re-pointing %s: %w", l, err))
			continue
		}
		linked = append(linked, l)
		ok("Re-pointed %s", ui.ShortPath(l))
	}
	for _, l := range p.Link {
		if err := os.MkdirAll(filepath.Dir(l), 0o755); err != nil {
			fail(fmt.Errorf("linking %s: %w", l, err))
			continue
		}
		if err := os.Symlink(filepath.Join(p.Store, filepath.Base(l)), l); err != nil {
			fail(fmt.Errorf("linking %s: %w", l, err))
			continue
		}
		linked = append(linked, l)
		ok("Linked %s", ui.ShortPath(l))
	}
	if p.Keep {
		var dirs []string
		for _, l := range append(linked, p.Kept...) {
			dirs = append(dirs, filepath.Dir(l))
		}
		if len(dirs) > 0 {
			fail(recordLinkedDirs(p.Store, dirs))
		}
	}
	// A link left behind is found again through the store's .linked-dirs, so
	// the store stays until every link is gone.
	if p.RemoveStore && unlinkFailed {
		fail(fmt.Errorf("kept %s so a re-run can remove the remaining links", p.Store))
	} else if p.RemoveStore {
		if err := os.RemoveAll(p.Store); err != nil {
			fail(fmt.Errorf("removing %s: %w", p.Store, err))
		} else {
			ok("Removed %s", ui.ShortPath(p.Store))
		}
	}
	return errors.Join(errs...)
}

// storeMatches reports whether dir holds exactly files: the same regular
// files with the same bytes, and nothing else.
func storeMatches(dir string, files map[string][]byte) bool {
	found := 0
	err := filepath.WalkDir(dir, func(path string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if e.IsDir() {
			return nil
		}
		if !e.Type().IsRegular() {
			return errors.New("not a regular file")
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		want, ok := files[filepath.ToSlash(rel)]
		if !ok {
			return errors.New("extra file")
		}
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, want) {
			return errors.New("differs")
		}
		found++
		return nil
	})
	return err == nil && found == len(files)
}

// writeSkill replaces the store's copy of s, building it beside the old one
// first so a failure never leaves half a skill under its real name.
func writeSkill(store string, s agentskill.Skill) error {
	if err := os.MkdirAll(store, 0o755); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(store, tmpPrefix+s.Name+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp) // a no-op once renamed
	if err := os.Chmod(tmp, 0o755); err != nil {
		return err
	}
	for rel, data := range s.Files {
		path := filepath.Join(tmp, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			return err
		}
	}
	final := filepath.Join(store, s.Name)
	if err := os.RemoveAll(final); err != nil {
		return err
	}
	return os.Rename(tmp, final)
}

// removeTmpSkills clears skills a crashed run left half-written.
func removeTmpSkills(store string) {
	entries, _ := os.ReadDir(store)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), tmpPrefix) {
			_ = os.RemoveAll(filepath.Join(store, e.Name()))
		}
	}
}

// readLinkedDirs returns the recorded skills directories. It is only a hint,
// so a missing or unreadable file is empty and a line that isn't an absolute
// path is skipped.
func readLinkedDirs(store string) []string {
	data, err := os.ReadFile(filepath.Join(store, linkedDirsFile))
	if err != nil {
		return nil
	}
	var dirs []string
	for _, line := range strings.Split(string(data), "\n") {
		if filepath.IsAbs(line) {
			dirs = append(dirs, filepath.Clean(line))
		}
	}
	return dirs
}

// recordLinkedDirs adds dirs to the store's record, sorted and unique.
func recordLinkedDirs(store string, dirs []string) error {
	all := readLinkedDirs(store)
	for _, d := range dirs {
		abs, err := filepath.Abs(d)
		if err != nil {
			return err
		}
		if !slices.Contains(all, abs) {
			all = append(all, abs)
		}
	}
	sort.Strings(all)
	if err := os.MkdirAll(store, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(store, linkedDirsFile), []byte(strings.Join(all, "\n")+"\n"), 0o644)
}
