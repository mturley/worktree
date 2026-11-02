package setup

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/mturley/worktree/internal/agentskill"
	"github.com/mturley/worktree/internal/ui"
)

// AgentSkillAction is what the agent skill step does this run.
type AgentSkillAction int

const (
	AgentSkillNone         AgentSkillAction = iota // current, or not installed and nobody to ask
	AgentSkillOfferInstall                         // interactive, not installed
	AgentSkillUpdate                               // ours, unedited, embedded content changed
	AgentSkillEditedSkip                           // ours, edited: never overwritten
	AgentSkillUserManaged                          // the path is there but isn't ours: never touched
)

const (
	agentSkillHashFile = ".worktree-skill-hash"
	agentSkillFile     = "SKILL.md"
)

// decideAgentSkill picks the step's action. installedHash is the content of
// the hash file and fileHash the hash of SKILL.md on disk; each is empty when
// its file is absent. An installed skill with no hash file isn't one setup
// wrote, which is what makes the copy safe to remove on uninstall.
func decideAgentSkill(installed bool, installedHash, fileHash, embeddedHash string, nonInteractive bool) AgentSkillAction {
	if !installed {
		if nonInteractive {
			return AgentSkillNone
		}
		return AgentSkillOfferInstall
	}
	if installedHash == "" {
		return AgentSkillUserManaged
	}
	if fileHash != installedHash {
		return AgentSkillEditedSkip
	}
	if installedHash != embeddedHash {
		return AgentSkillUpdate
	}
	return AgentSkillNone
}

type agentSkillDeps struct {
	Home     string
	Getenv   func(string) string
	Exists   func(string) bool
	Realpath func(string) (string, error)
	Confirm  func(string, bool) bool
}

func defaultAgentSkillDeps() agentSkillDeps {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "" // paths reports it as unusable
	}
	return agentSkillDeps{
		Home:     home,
		Getenv:   os.Getenv,
		Exists:   dirExists,
		Realpath: filepath.EvalSymlinks,
		Confirm:  confirmDefault,
	}
}

// paths is the canonical copy and the symlink locations. ok is false with no
// home directory, where the paths would be relative to the working directory.
func (d agentSkillDeps) paths() (canonical string, links []string, ok bool) {
	if d.Home == "" {
		return "", nil, false
	}
	for _, t := range agentskill.Targets(d.Home, d.Getenv, d.Exists, d.Realpath) {
		if t.Symlink {
			links = append(links, t.Dir)
		} else {
			canonical = t.Dir
		}
	}
	return canonical, links, true
}

func (d agentSkillDeps) action(nonInteractive bool) AgentSkillAction {
	canonical, _, ok := d.paths()
	if !ok {
		return AgentSkillNone
	}
	installed, installedHash, fileHash := readAgentSkillState(canonical)
	return decideAgentSkill(installed, installedHash, fileHash, agentskill.Hash(), nonInteractive)
}

// detectAgentSkill gathers the real machine state for decideAgentSkill.
func detectAgentSkill() AgentSkillAction {
	return defaultAgentSkillDeps().action(ui.NonInteractive())
}

// readAgentSkillState reads what is at the canonical path. Anything there but
// a real directory, such as a symlink to the user's own checkout, reports no
// hashes, so it counts as user-managed even if a hash file is reachable.
func readAgentSkillState(canonical string) (installed bool, installedHash, fileHash string) {
	info, err := os.Lstat(canonical)
	if err != nil {
		return false, "", ""
	}
	if !info.IsDir() {
		return true, "", ""
	}
	if data, err := os.ReadFile(filepath.Join(canonical, agentSkillHashFile)); err == nil {
		installedHash = strings.TrimSpace(string(data))
	}
	if data, err := os.ReadFile(filepath.Join(canonical, agentSkillFile)); err == nil {
		fileHash = hashBytes(data)
	}
	return true, installedHash, fileHash
}

func hashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// runAgentSkillStep installs or updates the skill. Both make any missing
// symlinks, which picks up an agent installed since the last run.
func runAgentSkillStep(a AgentSkillAction, d agentSkillDeps) error {
	if a != AgentSkillOfferInstall && a != AgentSkillUpdate {
		return nil
	}
	canonical, links, ok := d.paths()
	if !ok {
		return nil
	}
	if a == AgentSkillOfferInstall && !d.Confirm("Install the worktree skill for AI agents (Claude Code, Codex, pi…)?", true) {
		return nil
	}
	if err := writeAgentSkill(canonical); err != nil {
		return err
	}
	if a == AgentSkillOfferInstall {
		fmt.Printf("  %s Installed the worktree skill: %s\n", ui.Green("✓"), ui.ShortPath(canonical))
	} else {
		fmt.Printf("  %s Updated the worktree skill\n", ui.Green("✓"))
	}
	for _, link := range links {
		if err := linkAgentSkill(canonical, link); err != nil {
			return err
		}
	}
	return nil
}

func writeAgentSkill(canonical string) error {
	if err := os.MkdirAll(canonical, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(canonical, agentSkillFile), agentskill.Content, 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(canonical, agentSkillHashFile), []byte(agentskill.Hash()), 0o644)
}

// linkAgentSkill symlinks link to the canonical copy, and never replaces
// anything already at link. Lstat, so a dangling symlink counts as there.
func linkAgentSkill(canonical, link string) error {
	if _, err := os.Lstat(link); err == nil {
		if !linksTo(link, canonical) {
			fmt.Printf("  %s %s exists and isn't worktree's; leaving it\n", ui.Dim("—"), ui.ShortPath(link))
		}
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.Symlink(canonical, link); err != nil {
		return err
	}
	fmt.Printf("  %s Linked %s\n", ui.Green("✓"), ui.ShortPath(link))
	return nil
}

func linksTo(link, canonical string) bool {
	target, err := os.Readlink(link)
	return err == nil && filepath.Clean(target) == filepath.Clean(canonical)
}

func userManagedSkillNotice(canonical string) string {
	return fmt.Sprintf("%s has no %s, so it isn't worktree's; leaving it", ui.ShortPath(canonical), agentSkillHashFile)
}

// agentSkillRemoval is what uninstall may do: remove the canonical copy when
// it has our hash file, and each symlink pointing at it. A user-managed copy
// keeps its links too, since setup doesn't make links to a copy it doesn't own.
type agentSkillRemoval struct {
	canonical   string
	removeCopy  bool
	edited      bool
	userManaged bool
	links       []string
}

func planAgentSkillRemoval(d agentSkillDeps) agentSkillRemoval {
	canonical, all, ok := d.paths()
	if !ok {
		return agentSkillRemoval{}
	}
	installed, installedHash, fileHash := readAgentSkillState(canonical)
	if installed && installedHash == "" {
		return agentSkillRemoval{canonical: canonical, userManaged: true}
	}
	r := agentSkillRemoval{canonical: canonical, removeCopy: installed, edited: installed && fileHash != installedHash}
	for _, link := range all {
		if linksTo(link, canonical) {
			r.links = append(r.links, link)
		}
	}
	return r
}

// PreviewAgentSkillUninstall prints what UninstallAgentSkill would do and
// reports whether it would remove anything.
func PreviewAgentSkillUninstall(d agentSkillDeps) (any bool) {
	r := planAgentSkillRemoval(d)
	if r.userManaged {
		fmt.Printf("  %s %s\n", ui.Dim("—"), userManagedSkillNotice(r.canonical))
		return false
	}
	if r.removeCopy {
		note := ""
		if r.edited {
			note = " (edited)"
		}
		fmt.Printf("  • Remove the worktree skill: %s%s\n", ui.ShortPath(r.canonical), note)
		any = true
	}
	for _, link := range r.links {
		fmt.Printf("  • Remove its symlink: %s\n", ui.ShortPath(link))
		any = true
	}
	return any
}

// UninstallAgentSkill removes the symlinks, then the copy. Nothing else in the
// skill directories is touched: sibling skills and foreign entries stay.
func UninstallAgentSkill(d agentSkillDeps) error {
	r := planAgentSkillRemoval(d)
	if r.userManaged {
		fmt.Printf("  %s %s\n", ui.Dim("—"), userManagedSkillNotice(r.canonical))
		return nil
	}
	for _, link := range r.links {
		if err := os.Remove(link); err != nil {
			return fmt.Errorf("removing %s: %w", link, err)
		}
		fmt.Printf("  %s Removed %s\n", ui.Green("✓"), ui.ShortPath(link))
	}
	if r.removeCopy {
		if err := os.RemoveAll(r.canonical); err != nil {
			return fmt.Errorf("removing %s: %w", r.canonical, err)
		}
		fmt.Printf("  %s Removed %s\n", ui.Green("✓"), ui.ShortPath(r.canonical))
	}
	return nil
}
