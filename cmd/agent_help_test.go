package cmd

import (
	"bytes"
	"regexp"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/agentskill"
	"github.com/spf13/cobra"
)

func TestAgentHelpPrintsSkillWithoutFrontmatter(t *testing.T) {
	var out bytes.Buffer
	agentHelpCmd.SetOut(&out)
	t.Cleanup(func() { agentHelpCmd.SetOut(nil) })
	if err := agentHelpCmd.RunE(agentHelpCmd, nil); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "name: worktree") {
		t.Error("frontmatter was printed")
	}
	if !strings.Contains(out.String(), "worktree status --json") {
		t.Errorf("body missing: %q", out.String())
	}
	if agentHelpCmd.GroupID != "admin" {
		t.Errorf("group = %q", agentHelpCmd.GroupID)
	}
}

var skillCommand = regexp.MustCompile("`worktree ([^`]+)`")

// Every command the skill teaches must exist, with every flag it names:
// agents run them as written.
func TestSkillCommandsAreReal(t *testing.T) {
	matches := skillCommand.FindAllStringSubmatch(string(agentskill.Content), -1)
	if len(matches) < 20 {
		t.Fatalf("found only %d commands; has the skill's format changed?", len(matches))
	}
	for _, m := range matches {
		var words []string
		var flags []string
		for _, tok := range strings.Fields(m[1]) {
			switch {
			case strings.HasPrefix(tok, "--"):
				name, _, _ := strings.Cut(strings.TrimPrefix(tok, "--"), "=")
				flags = append(flags, name)
			case len(flags) == 0:
				words = append(words, tok)
			}
		}
		c, rest, err := rootCmd.Find(words)
		if err != nil || c == rootCmd {
			t.Errorf("`worktree %s`: no such command (%v)", m[1], err)
			continue
		}
		if c.HasSubCommands() && len(rest) > 0 {
			t.Errorf("`worktree %s`: %s has no subcommand %q", m[1], c.Name(), rest[0])
		}
		for _, f := range flags {
			if c.Flags().Lookup(f) == nil && c.InheritedFlags().Lookup(f) == nil &&
				c.PersistentFlags().Lookup(f) == nil && rootCmd.PersistentFlags().Lookup(f) == nil {
				t.Errorf("`worktree %s`: %s has no flag --%s", m[1], c.Name(), f)
			}
		}
	}
}

// subcommand returns the named child of rootCmd.
func subcommand(t *testing.T, name string) *cobra.Command {
	t.Helper()
	c, _, err := rootCmd.Find([]string{name})
	if err != nil || c == rootCmd {
		t.Fatalf("no command %s", name)
	}
	return c
}

// The writes section must name every write, including ones added later.
func TestSkillNamesEveryWrite(t *testing.T) {
	content := string(agentskill.Content)
	_, writes, ok := strings.Cut(content, "## Never write without")
	if !ok {
		t.Fatal("no writes section")
	}
	want := []string{"worktree notes set", "worktree add", "worktree delete", "worktree cleanup"}
	for _, c := range subcommand(t, "resources").Commands() {
		if c.Name() != "list" {
			want = append(want, "worktree resources "+c.Name())
		}
	}
	for _, c := range subcommand(t, "tasks").Commands() {
		if c.Name() != "list" && c.Name() != "show" {
			want = append(want, "worktree tasks "+c.Name())
		}
	}
	for _, w := range want {
		if !strings.Contains(writes, w) {
			t.Errorf("the writes section does not name %q", w)
		}
	}
}
