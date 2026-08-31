package cmd

import (
	"fmt"
	"strconv"

	"github.com/mturley/worktree/internal/addcheck"
	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/resourceurl"
	"github.com/mturley/worktree/internal/slackurl"
	"github.com/spf13/cobra"
)

var addCmd = &cobra.Command{
	Use:   "add <branch-name | PR-number | PR-URL | Jira-URL>",
	Short: "Create a worktree",
	Long: `Create a worktree from a branch name, PR number/URL, or Jira issue URL.

Note: a bare numeric argument (e.g. "1234") is always treated as a PR number,
never as a branch name — a purely numeric branch cannot be created this way.`,
	GroupID: "worktree",
	Args:    cobra.ExactArgs(1),
	RunE:    runAdd,
}

func init() {
	rootCmd.AddCommand(addCmd)
}

type addKind int

const (
	addBranch addKind = iota
	addJira
	addPRNumber
	addPRURL
)

// classifyAddInput decides which creation path an argument takes, and rejects
// the two forms that never created a worktree.
//
// The rejection is the point. runAdd used to fall through to handleBranch for
// anything it did not recognize, so simply dropping the Slack and path
// branches would silently create a branch named after the URL or path. Each
// removed form keeps its detection and names the command that replaced it.
func classifyAddInput(arg string) (addKind, error) {
	if resourceurl.PRURLPattern.MatchString(arg) {
		return addPRURL, nil
	}
	if jira.IsJiraURL(arg) {
		return addJira, nil
	}
	if _, _, ok := slackurl.Parse(arg); ok {
		return 0, fmt.Errorf(
			"Slack URLs are tracked as resources, not worktrees.\n  Try: worktree resources add %s", arg)
	}
	if _, err := strconv.Atoi(arg); err == nil {
		return addPRNumber, nil
	}
	if addcheck.ExistingWorktreeDir(arg) {
		return 0, fmt.Errorf(
			"that path is an existing worktree.\n  Try: worktree info %s", arg)
	}
	return addBranch, nil
}

func runAdd(cmd *cobra.Command, args []string) error {
	arg := args[0]
	kind, err := classifyAddInput(arg)
	if err != nil {
		return err
	}

	switch kind {
	case addPRURL:
		m := resourceurl.PRURLPattern.FindStringSubmatch(arg)
		number, _ := strconv.Atoi(m[3])
		return handlePR(m[1], m[2], number)
	case addJira:
		return handleJiraURL(arg)
	case addPRNumber:
		return handlePRNumber(arg)
	default:
		return handleBranch(arg)
	}
}
