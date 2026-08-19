package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/slackurl"
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

	if ch, ts, ok := slackurl.Parse(arg); ok {
		return handleSlackURL(arg, ch, ts)
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

// handleSlackURL attaches a Slack thread as a resource on the current
// worktree (identified by cwd), rather than creating a new worktree.
func handleSlackURL(url, channel, threadTS string) error {
	wt, err := os.Getwd()
	if err != nil {
		return err
	}

	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()

	id := slackurl.ResourceID(channel, threadTS)
	if err := resources.Add(conn, wt, resources.Resource{Type: "slack", ID: id, URL: url}); err != nil {
		return err
	}
	fmt.Printf("  Tracking Slack thread %s\n", id)
	return nil
}
