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

// skillReadCommands are the commands that change nothing. Every other command
// must be named in the skill's writes section, so a new command fails
// TestSkillNamesEveryWrite until someone decides which it is.
var skillReadCommands = map[string]bool{
	"worktree activity":             true,
	"worktree agent-help":           true,
	"worktree attention":            true,
	"worktree env":                  true,
	"worktree info":                 true,
	"worktree jira":                 true,
	"worktree linked":               true,
	"worktree list":                 true,
	"worktree notes show":           true,
	"worktree ports":                true,
	"worktree pr-threads list":      true,
	"worktree resources list":       true,
	"worktree review-comments list": true,
	"worktree status":               true,
	"worktree tasks list":           true,
	"worktree tasks show":           true,
	"worktree unread":               true,
	"worktree version":              true,
}

// runnableCommands walks the tree below c. help and completion are cobra's own,
// and only exist here once something has executed rootCmd.
func runnableCommands(c *cobra.Command) []*cobra.Command {
	var out []*cobra.Command
	for _, sub := range c.Commands() {
		if sub.Name() == "help" || sub.Name() == "completion" {
			continue
		}
		if sub.Runnable() {
			out = append(out, sub)
		}
		out = append(out, runnableCommands(sub)...)
	}
	return out
}

// The writes section must name every write, including ones added later.
func TestSkillNamesEveryWrite(t *testing.T) {
	_, writes, ok := strings.Cut(string(agentskill.Content), "## Never write without")
	if !ok {
		t.Fatal("no writes section")
	}
	seen := map[string]bool{}
	for _, c := range runnableCommands(rootCmd) {
		path := c.CommandPath()
		seen[path] = true
		named := strings.Contains(writes, "`"+path+"`")
		switch {
		case skillReadCommands[path] && named:
			t.Errorf("%q is both on the read-only allowlist and in the writes section", path)
		case !skillReadCommands[path] && !named:
			t.Errorf("%q is neither on the read-only allowlist nor in the writes section", path)
		}
	}
	for path := range skillReadCommands {
		if !seen[path] {
			t.Errorf("the read-only allowlist names %q, which doesn't exist", path)
		}
	}
}
