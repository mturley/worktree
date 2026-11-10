// Package agentskill holds worktree's skills for AI agents: the embedded
// skills/ directory (one subdirectory per skill), where setup keeps their
// copies, and where agents look for them. Installing them is internal/setup's
// job.
package agentskill

import (
	"bytes"
	"embed"
	"io/fs"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

//go:embed skills
var skillsFS embed.FS

// Skill is one embedded skill: its directory name and every file in it.
type Skill struct {
	Name string
	// Files maps slash-separated paths relative to the skill's directory to
	// their content.
	Files map[string][]byte
}

// Skills returns every skill under the embedded skills/ directory, sorted by
// name.
func Skills() []Skill {
	entries, err := fs.ReadDir(skillsFS, "skills")
	if err != nil {
		panic(err) // the directory is embedded: it always exists
	}
	var skills []Skill
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		root := path.Join("skills", e.Name())
		s := Skill{Name: e.Name(), Files: map[string][]byte{}}
		err := fs.WalkDir(skillsFS, root, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			data, err := skillsFS.ReadFile(p)
			if err != nil {
				return err
			}
			s.Files[strings.TrimPrefix(p, root+"/")] = data
			return nil
		})
		if err != nil {
			panic(err)
		}
		skills = append(skills, s)
	}
	sort.Slice(skills, func(i, j int) bool { return skills[i].Name < skills[j].Name })
	return skills
}

// StoreDir is where setup keeps the skills' real copies, beside worktree's
// database: $XDG_DATA_HOME/worktree/skills, or ~/.local/share/worktree/skills.
// A relative XDG_DATA_HOME is ignored, as the XDG spec says: links into it
// would resolve against whatever directory an agent runs in.
func StoreDir(home string, getenv func(string) string) string {
	base := getenv("XDG_DATA_HOME")
	if !filepath.IsAbs(base) {
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "worktree", "skills")
}

// Content is SKILL.md, frontmatter included.
//
//go:embed skills/worktree/SKILL.md
var Content []byte

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

// SkillDirs lists the skills directories agents read, ~/.agents/skills first
// and always (setup creates it). Verified:
//
//   - Codex reads $HOME/.agents/skills at user scope and follows symlinked
//     skill folders (developers.openai.com/codex/skills →
//     learn.chatgpt.com/docs/build-skills), 2026-10-31.
//   - pi (≥ 1.3.0) reads ~/.agents/skills/ (@earendil-works/pi-coding-agent
//     docs/skills.md), 2026-10-31; pi 1.5.0 follows symlinked skill folders
//     (dist/core/skills.js stats through symlink entries), 2026-11-10.
//   - Claude Code reads only ~/.claude/skills (or $CLAUDE_CONFIG_DIR/skills)
//     at user scope, 2026-10-31.
//
// A Claude skills directory that doesn't exist is left out. Directories are
// deduplicated by realpath, starting from ~/.agents/skills: two config
// directories can share one skills directory through symlinks, and one could
// even be ~/.agents/skills itself.
func SkillDirs(home string, getenv func(string) string, exists func(string) bool, realpath func(string) (string, error)) []string {
	agents := filepath.Join(home, ".agents", "skills")
	dirs := []string{agents}

	real := func(d string) string {
		if r, err := realpath(d); err == nil {
			return r
		}
		return d
	}
	seen := map[string]bool{real(agents): true}

	var claude []string
	if cfg := getenv("CLAUDE_CONFIG_DIR"); cfg != "" {
		claude = append(claude, filepath.Join(cfg, "skills"))
	}
	claude = append(claude, filepath.Join(home, ".claude", "skills"))
	for _, d := range claude {
		if !exists(d) {
			continue
		}
		r := real(d)
		if seen[r] {
			continue
		}
		seen[r] = true
		dirs = append(dirs, d)
	}
	return dirs
}
