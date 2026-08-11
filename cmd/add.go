package cmd

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/mturley/worktree/internal/jira"
	"github.com/spf13/cobra"
)

var addCmd = &cobra.Command{
	Use:     "add <PR-number | PR-URL | Jira-URL | branch-name | path>",
	Short:   "Create or open a worktree",
	GroupID: "worktree",
	Args:    cobra.ExactArgs(1),
	RunE:    runAdd,
}

func init() {
	rootCmd.AddCommand(addCmd)
}

func runAdd(cmd *cobra.Command, args []string) error {
	arg := args[0]

	if m := prURLPattern.FindStringSubmatch(arg); m != nil {
		owner, repo := m[1], m[2]
		number, _ := strconv.Atoi(m[3])
		return handlePR(owner, repo, number)
	}

	if jira.IsJiraURL(arg) {
		return handleJiraURL(arg)
	}

	if _, err := strconv.Atoi(arg); err == nil {
		return handlePRNumber(arg)
	}

	if info, err := os.Stat(arg); err == nil && info.IsDir() {
		if _, err := os.Stat(filepath.Join(arg, ".git")); err == nil {
			return runInfo(cmd, args)
		}
		gitFile := filepath.Join(arg, ".git")
		if data, err := os.ReadFile(gitFile); err == nil && strings.HasPrefix(string(data), "gitdir:") {
			return runInfo(cmd, args)
		}
	}

	return handleBranch(arg)
}
