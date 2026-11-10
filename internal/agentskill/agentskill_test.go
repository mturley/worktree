package agentskill

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"slices"
	"testing"
)

func noEnv(string) string { return "" }

func envWith(k, v string) func(string) string {
	return func(name string) string {
		if name == k {
			return v
		}
		return ""
	}
}

func existsIn(dirs ...string) func(string) bool {
	return func(p string) bool {
		for _, d := range dirs {
			if d == p {
				return true
			}
		}
		return false
	}
}

func sameRealpath(p string) (string, error) { return p, nil }

func TestSkillFrontmatter(t *testing.T) {
	t.Parallel()
	if !bytes.HasPrefix(Content, []byte("---\nname: worktree\n")) {
		t.Errorf("Content starts %q", Content[:min(len(Content), 40)])
	}
	if !bytes.Contains(Content, []byte("\ndescription: Use when the user asks about their worktrees")) {
		t.Error("frontmatter has no description")
	}
}

func TestHashIsSHA256OfContent(t *testing.T) {
	t.Parallel()
	sum := sha256.Sum256(Content)
	if got, want := Hash(), hex.EncodeToString(sum[:]); got != want {
		t.Errorf("Hash() = %s, want %s", got, want)
	}
}

func TestStripFrontmatter(t *testing.T) {
	t.Parallel()
	cases := []struct{ name, in, want string }{
		{"frontmatter", "---\nname: x\n---\n\n# Body\n", "# Body\n"},
		{"no frontmatter", "# Body\n", "# Body\n"},
		{"unterminated", "---\nname: x\n# Body\n", "---\nname: x\n# Body\n"},
		{"a rule in the body stays", "---\nname: x\n---\nA\n---\nB\n", "A\n---\nB\n"},
	}
	for _, c := range cases {
		if got := string(StripFrontmatter([]byte(c.in))); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestBodyHasNoFrontmatter(t *testing.T) {
	t.Parallel()
	body := Body()
	if bytes.Contains(body, []byte("name: worktree")) || !bytes.HasPrefix(body, []byte("# ")) {
		t.Errorf("Body() starts %q", body[:min(len(body), 40)])
	}
}

func TestTargetsClaudeConfigDir(t *testing.T) {
	t.Parallel()
	canonical := Target{Dir: "/home/.agents/skills/worktree"}

	got := Targets("/home", envWith("CLAUDE_CONFIG_DIR", "/x"), existsIn("/x/skills"), sameRealpath)
	want := []Target{canonical, {Dir: "/x/skills/worktree", Symlink: true}}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("with the variable: got %+v, want %+v", got, want)
	}

	got = Targets("/home", noEnv, existsIn("/x/skills"), sameRealpath)
	if len(got) != 1 || got[0] != canonical {
		t.Errorf("without the variable: got %+v, want only the canonical copy", got)
	}
}

func TestTargetsLinksDefaultClaudeDir(t *testing.T) {
	t.Parallel()
	got := Targets("/home", noEnv, existsIn("/home/.claude/skills"), sameRealpath)
	if len(got) != 2 || got[1] != (Target{Dir: "/home/.claude/skills/worktree", Symlink: true}) {
		t.Errorf("got %+v", got)
	}
}

func TestTargetsSkipsMissingParent(t *testing.T) {
	t.Parallel()
	got := Targets("/home", envWith("CLAUDE_CONFIG_DIR", "/x"), existsIn(), sameRealpath)
	if len(got) != 1 || got[0].Symlink {
		t.Errorf("got %+v, want only the canonical copy", got)
	}
}

func TestTargetsDedupesByRealpath(t *testing.T) {
	t.Parallel()
	real := func(p string) (string, error) {
		if p == "/home/.claude-personal/skills" || p == "/home/.claude/skills" {
			return "/shared/skills", nil
		}
		return p, nil
	}
	got := Targets("/home", envWith("CLAUDE_CONFIG_DIR", "/home/.claude-personal"),
		existsIn("/home/.claude-personal/skills", "/home/.claude/skills"), real)
	if len(got) != 2 || got[1].Dir != "/home/.claude-personal/skills/worktree" {
		t.Errorf("got %+v, want one symlink target", got)
	}
}

// A skills directory that IS the canonical one must not get a link: the
// target would be the canonical copy's own path.
func TestTargetsSkipsDirSharedWithCanonical(t *testing.T) {
	t.Parallel()
	real := func(p string) (string, error) {
		if p == "/home/.claude/skills" || p == "/home/.agents/skills" {
			return "/home/.agents/skills", nil
		}
		return p, nil
	}
	got := Targets("/home", noEnv, existsIn("/home/.claude/skills", "/home/.agents/skills"), real)
	if len(got) != 1 || got[0].Symlink {
		t.Errorf("got %+v, want only the canonical copy", got)
	}
}

// A realpath failure is not a reason to drop an existing directory.
func TestTargetsRealpathFailureKeepsDir(t *testing.T) {
	t.Parallel()
	fail := func(string) (string, error) { return "", errors.New("nope") }
	got := Targets("/home", noEnv, existsIn("/home/.claude/skills"), fail)
	if len(got) != 2 || got[1].Dir != "/home/.claude/skills/worktree" {
		t.Errorf("got %+v", got)
	}
}

func TestSkillsMatchTheirDirectories(t *testing.T) {
	t.Parallel()
	skills := Skills()
	if len(skills) == 0 {
		t.Fatal("no skills embedded")
	}
	seen := map[string]bool{}
	for i, s := range skills {
		if i > 0 && skills[i-1].Name >= s.Name {
			t.Errorf("not sorted and unique: %q then %q", skills[i-1].Name, s.Name)
		}
		seen[s.Name] = true
		md, ok := s.Files["SKILL.md"]
		if !ok {
			t.Errorf("%s has no SKILL.md", s.Name)
			continue
		}
		if !bytes.HasPrefix(md, []byte("---\nname: "+s.Name+"\n")) {
			t.Errorf("%s: SKILL.md frontmatter doesn't name it: %q", s.Name, md[:min(len(md), 40)])
		}
	}
	if !seen["worktree"] {
		t.Fatal("no worktree skill")
	}
	for _, s := range skills {
		if s.Name == "worktree" && !bytes.Equal(s.Files["SKILL.md"], Content) {
			t.Error("worktree's SKILL.md differs from Content")
		}
	}
}

func TestStoreDir(t *testing.T) {
	t.Parallel()
	cases := []struct{ name, xdg, want string }{
		{"absolute XDG_DATA_HOME", "/data", "/data/worktree/skills"},
		{"relative XDG_DATA_HOME is ignored", "rel/data", "/home/.local/share/worktree/skills"},
		{"unset", "", "/home/.local/share/worktree/skills"},
	}
	for _, c := range cases {
		if got := StoreDir("/home", envWith("XDG_DATA_HOME", c.xdg)); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestSkillDirsClaudeConfigDir(t *testing.T) {
	t.Parallel()
	got := SkillDirs("/home", envWith("CLAUDE_CONFIG_DIR", "/x"), existsIn("/x/skills"), sameRealpath)
	if want := []string{"/home/.agents/skills", "/x/skills"}; !slices.Equal(got, want) {
		t.Errorf("with the variable: got %v, want %v", got, want)
	}
	got = SkillDirs("/home", noEnv, existsIn("/x/skills"), sameRealpath)
	if want := []string{"/home/.agents/skills"}; !slices.Equal(got, want) {
		t.Errorf("without the variable: got %v, want %v", got, want)
	}
}

func TestSkillDirsDefaultClaudeDir(t *testing.T) {
	t.Parallel()
	got := SkillDirs("/home", noEnv, existsIn("/home/.claude/skills"), sameRealpath)
	if want := []string{"/home/.agents/skills", "/home/.claude/skills"}; !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestSkillDirsSkipsMissingParent(t *testing.T) {
	t.Parallel()
	got := SkillDirs("/home", envWith("CLAUDE_CONFIG_DIR", "/x"), existsIn(), sameRealpath)
	if want := []string{"/home/.agents/skills"}; !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestSkillDirsDedupesByRealpath(t *testing.T) {
	t.Parallel()
	real := func(p string) (string, error) {
		if p == "/home/.claude-personal/skills" || p == "/home/.claude/skills" {
			return "/shared/skills", nil
		}
		return p, nil
	}
	got := SkillDirs("/home", envWith("CLAUDE_CONFIG_DIR", "/home/.claude-personal"),
		existsIn("/home/.claude-personal/skills", "/home/.claude/skills"), real)
	if want := []string{"/home/.agents/skills", "/home/.claude-personal/skills"}; !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestSkillDirsSkipsDirSharedWithAgents(t *testing.T) {
	t.Parallel()
	real := func(p string) (string, error) {
		if p == "/home/.claude/skills" || p == "/home/.agents/skills" {
			return "/home/.agents/skills", nil
		}
		return p, nil
	}
	got := SkillDirs("/home", noEnv, existsIn("/home/.claude/skills", "/home/.agents/skills"), real)
	if want := []string{"/home/.agents/skills"}; !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestSkillDirsRealpathFailureKeepsDir(t *testing.T) {
	t.Parallel()
	fail := func(string) (string, error) { return "", errors.New("nope") }
	got := SkillDirs("/home", noEnv, existsIn("/home/.claude/skills"), fail)
	if want := []string{"/home/.agents/skills", "/home/.claude/skills"}; !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}
