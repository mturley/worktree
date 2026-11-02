// Package agentskill holds the worktree skill for AI agents: the embedded
// SKILL.md, and where agents look for it. Installing it is internal/setup's job.
package agentskill

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"path/filepath"
)

// Content is SKILL.md, frontmatter included.
//
//go:embed SKILL.md
var Content []byte

// Hash identifies this version of Content.
func Hash() string {
	sum := sha256.Sum256(Content)
	return hex.EncodeToString(sum[:])
}

// Body is Content without its frontmatter: what `worktree agent-help` prints.
func Body() []byte { return StripFrontmatter(Content) }

// StripFrontmatter removes a leading "---" block and the blank lines after
// it. Anything without a complete block comes back unchanged.
func StripFrontmatter(b []byte) []byte {
	const fence = "---\n"
	if !bytes.HasPrefix(b, []byte(fence)) {
		return b
	}
	end := bytes.Index(b[len(fence):], []byte("\n"+fence))
	if end < 0 {
		return b
	}
	return bytes.TrimLeft(b[len(fence)+end+1+len(fence):], "\n")
}

// Target is one place the skill goes: the canonical copy, or a symlink to it.
type Target struct {
	Dir     string
	Symlink bool
}

// Targets lists where the skill belongs, the canonical copy first. Verified
// 2026-10-31:
//
//   - Codex reads $HOME/.agents/skills at user scope and follows symlinked
//     skill folders (developers.openai.com/codex/skills →
//     learn.chatgpt.com/docs/build-skills).
//   - pi (≥ 1.3.0) reads ~/.agents/skills/ (@earendil-works/pi-coding-agent
//     docs/skills.md).
//   - Claude Code reads only ~/.claude/skills (or $CLAUDE_CONFIG_DIR/skills)
//     at user scope, hence the symlinks.
//
// A skills directory that doesn't exist gets no link. Directories are
// deduplicated by realpath, starting from the canonical copy's own parent: two
// config directories can share one skills directory through symlinks, and one
// could even be ~/.agents/skills itself, where a link would be the copy's path.
func Targets(home string, getenv func(string) string, exists func(string) bool, realpath func(string) (string, error)) []Target {
	canonical := filepath.Join(home, ".agents", "skills")
	targets := []Target{{Dir: filepath.Join(canonical, "worktree")}}

	real := func(d string) string {
		if r, err := realpath(d); err == nil {
			return r
		}
		return d
	}
	seen := map[string]bool{real(canonical): true}

	var dirs []string
	if cfg := getenv("CLAUDE_CONFIG_DIR"); cfg != "" {
		dirs = append(dirs, filepath.Join(cfg, "skills"))
	}
	dirs = append(dirs, filepath.Join(home, ".claude", "skills"))
	for _, d := range dirs {
		if !exists(d) {
			continue
		}
		r := real(d)
		if seen[r] {
			continue
		}
		seen[r] = true
		targets = append(targets, Target{Dir: filepath.Join(d, "worktree"), Symlink: true})
	}
	return targets
}
