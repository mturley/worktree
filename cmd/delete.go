package cmd

import (
	"fmt"
	"os"
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

	fmt.Printf("Worktree: %s\n", ui.ShortPath(wtPath))
	fmt.Printf("Branch:   %s\n", gitBranch(wtPath))

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
	if !deleteBranch && !deleteForce {
		if b := gitBranch(wtPath); b != "" {
			deleteBranch = ui.ConfirmDefault(
				fmt.Sprintf("Delete the branch %q too?", b), false)
		}
	}

	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()

	opts := worktreedel.Options{Path: wtPath, DeleteBranch: deleteBranch}
	for {
		res := worktreedel.Run(conn, cfg, opts, func(s worktreedel.Step) {
			switch s.Status {
			case worktreedel.StatusDone:
				fmt.Printf("%s %s\n", ui.Green("✓"), s.Label)
			case worktreedel.StatusSkipped:
				fmt.Printf("%s %s (%s)\n", ui.Green("✓"), s.Label, s.Detail)
			case worktreedel.StatusFailed:
				fmt.Fprintf(os.Stderr, "Warning: %s: %s\n", s.Label, s.Detail)
			}
		})
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
