package cmd

import (
	"fmt"
	"path/filepath"

	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/ui"
	"github.com/mturley/worktree/internal/worktreedel"
	"github.com/spf13/cobra"
)

var deleteForce bool
var deleteBranchFlag bool

var deleteCmd = &cobra.Command{
	Use:     "delete [path]",
	Short:   "Remove a worktree and clean up associated files",
	GroupID: "worktree",
	RunE:    runDelete,
}

func init() {
	deleteCmd.Flags().BoolVar(&deleteForce, "force", false, "Skip confirmation")
	deleteCmd.Flags().BoolVar(&deleteBranchFlag, "delete-branch", false,
		"Also delete the worktree's branch")
	rootCmd.AddCommand(deleteCmd)
}

func runDelete(cmd *cobra.Command, args []string) error {
	wtPath, err := resolveWorktreePath(args)
	if err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	repoRoot := ""
	if r, err := gitutil.RepoRoot(wtPath); err == nil {
		repoRoot = r
	}
	commonDir := gitutil.CommonDir(wtPath)
	if commonDir != "" && commonDir != ".git" {
		mainRoot := filepath.Dir(commonDir)
		repoRoot = mainRoot
	}

	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()

	// The branch comes from the runner, not from inspecting the directory:
	// after a half-finished delete the directory is gone and only the
	// registry still knows the branch. Asking the directory then yielded
	// gitBranch's "(unknown)" placeholder, which was offered for deletion as
	// though it were a real branch name.
	branch := worktreedel.Branch(conn, cfg, wtPath)
	shownBranch := branch
	if shownBranch == "" {
		shownBranch = ui.Dim("none (detached HEAD or not recorded)")
	}
	fmt.Printf("Worktree: %s\n", ui.ShortPath(wtPath))
	fmt.Printf("Branch:   %s\n", shownBranch)

	if !deleteForce {
		if !ui.Confirm("Remove this worktree?") {
			fmt.Println("Cancelled.")
			return nil
		}
	}

	// Branch deletion is opt-in and defaults to NO. Removing a worktree
	// destroys no work; deleting an unmerged branch can, so it must never
	// happen to someone holding down enter. --force skips the confirmation
	// for the worktree, not the branch; --delete-branch is the scriptable way.
	deleteBranch := deleteBranchFlag
	if !deleteBranch && !deleteForce && branch != "" {
		deleteBranch = ui.ConfirmDefault(
			fmt.Sprintf("Delete the branch %q too?", branch), false)
	}

	opts := worktreedel.Options{Path: wtPath, DeleteBranch: deleteBranch}
	var printer stepPrinter
	for {
		res := worktreedel.Run(conn, cfg, opts, printer.observeDelete)
		// Every outcome clears its own spinner, but a run that errors before
		// reporting one must not leave a spinner turning under the error.
		printer.clear()
		if res.Err != nil {
			return res.Err
		}
		if res.NeedsForce == "" {
			return nil
		}
		step := stepByKey(res, res.NeedsForce)
		fmt.Printf("\n%s %s:\n  %s\n\n", ui.Yellow("!"), step.Label, step.Detail)
		if res.NeedsForce == worktreedel.StepRemoveDirectory {
			fmt.Println("This is usually leftover build output or read-only files in the worktree.")
			if !ui.Confirm("Force-remove the directory (fix permissions and delete)?") {
				fmt.Printf("\nLeaving the worktree in place. To remove it manually:\n")
				fmt.Printf("  rm -rf %s\n  git -C %s worktree prune\n  worktree cleanup\n", wtPath, repoRoot)
				return nil
			}
			opts.ForceDirectory = true
			continue
		}
		if !ui.Confirm("Force-delete the branch (discards unmerged commits)?") {
			fmt.Println("Leaving the branch in place; finishing the rest of the cleanup.")
			opts.DeleteBranch = false
			continue
		}
		opts.ForceBranch = true
	}
}

func stepByKey(res worktreedel.Result, key worktreedel.StepKey) worktreedel.Step {
	for _, s := range res.Steps {
		if s.Key == key {
			return s
		}
	}
	return worktreedel.Step{}
}
