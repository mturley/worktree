package cmd

import (
	"fmt"
	"strings"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/spf13/cobra"
)

var (
	reviewCommentsWorktree string
	reviewCommentsJSON     bool
)

var reviewCommentsCmd = &cobra.Command{
	Use:     "review-comments",
	Short:   "Read a worktree's draft review comments",
	GroupID: "worktree",
}

var reviewCommentsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List a worktree's review comments",
	Long: "List the review comments left on a worktree's diff, sorted by file and line.\n" +
		"Each is placed in the working tree: current, moved (the lines shifted) or\n" +
		"outdated (the code changed or the file is gone). Read-only.\n\n" +
		"--worktree defaults to the current worktree.",
	Example: "  worktree review-comments list --json",
	Args:    cobra.NoArgs,
	RunE:    runReviewCommentsList,
}

func init() {
	reviewCommentsCmd.PersistentFlags().StringVar(&reviewCommentsWorktree, "worktree", "", `the worktree ("." or a path; default: the current one)`)
	reviewCommentsListCmd.Flags().BoolVar(&reviewCommentsJSON, "json", false, `print {"schema_version": 1, "comments": [...]}`)
	reviewCommentsCmd.AddCommand(reviewCommentsListCmd)
	rootCmd.AddCommand(reviewCommentsCmd)
}

func runReviewCommentsList(cmd *cobra.Command, args []string) error {
	conn, err := wdb.OpenRead()
	if err != nil {
		return err
	}
	defer conn.Close()
	path, err := perWorktreePath(conn, reviewCommentsWorktree)
	if err != nil {
		return err
	}
	srv, err := headlessServer(conn)
	if err != nil {
		return err
	}
	items, err := srv.ReviewComments(path)
	if err != nil {
		return err
	}
	w := cmd.OutOrStdout()
	if reviewCommentsJSON {
		return printJSON(w, map[string]any{"comments": items})
	}
	for _, it := range items {
		first, _, _ := strings.Cut(it.Body, "\n")
		fmt.Fprintf(w, "%s:%d  [%s]  %s\n", it.File, it.Prompt.StartLine, it.Prompt.Status, first)
	}
	return nil
}
