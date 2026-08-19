package cmd

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

var deleteForce bool

var deleteCmd = &cobra.Command{
	Use:     "delete [path]",
	Short:   "Remove a worktree and clean up associated files",
	GroupID: "worktree",
	RunE:    runDelete,
}

func init() {
	deleteCmd.Flags().BoolVar(&deleteForce, "force", false, "Skip confirmation")
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

	repoName := ""
	wtName := filepath.Base(wtPath)

	repoRoot := ""
	if r, err := gitutil.RepoRoot(wtPath); err == nil {
		repoRoot = r
	}
	commonDir := gitutil.CommonDir(wtPath)
	if commonDir != "" && commonDir != ".git" {
		mainRoot := filepath.Dir(commonDir)
		repoName = filepath.Base(mainRoot)
		repoRoot = mainRoot
	} else {
		repoName = filepath.Base(filepath.Dir(wtPath))
	}

	fmt.Printf("Worktree: %s\n", ui.ShortPath(wtPath))
	fmt.Printf("Branch:   %s\n", gitBranch(wtPath))

	if !deleteForce {
		if !ui.Confirm("Remove this worktree?") {
			fmt.Println("Cancelled.")
			return nil
		}
	}

	if repoRoot != "" {
		err := ui.SpinWhile("Removing worktree", func() error {
			return gitutil.RemoveWorktree(repoRoot, wtPath)
		})
		var needsForce *gitutil.ErrNeedsForce
		if errors.As(err, &needsForce) {
			fmt.Printf("\n%s git could not remove the worktree:\n  %s\n\n",
				ui.Yellow("!"), needsForce.GitOutput)
			fmt.Println("This is usually leftover build output or read-only files in the worktree.")
			if ui.Confirm("Force-remove the directory (fix permissions and delete)?") {
				if err := ui.SpinWhile("Force-removing worktree", func() error {
					return gitutil.ForceRemoveWorktree(repoRoot, cfg.WorktreesBase, wtPath)
				}); err != nil {
					return err
				}
			} else {
				fmt.Printf("\nLeaving the worktree in place. To remove it manually:\n")
				fmt.Printf("  rm -rf %s\n", wtPath)
				fmt.Printf("  git -C %s worktree prune\n", repoRoot)
				fmt.Printf("  worktree cleanup\n")
				return nil
			}
		} else if err != nil {
			return err
		}
	}

	conn, err := wdb.Open()
	if err == nil {
		defer conn.Close()
		if err := ports.Release(conn, wtName); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to release port range: %v\n", err)
		} else {
			fmt.Printf("%s Released port range\n", ui.Green("✓"))
		}
		if err := registry.Unregister(conn, wtPath); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to unregister worktree: %v\n", err)
		}
		if err := resources.RemoveAll(conn, wtPath); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to remove tracked resources: %v\n", err)
		}
	}

	kubePath := env.KubeconfigPath(repoName, wtName)
	if err := os.Remove(kubePath); err == nil {
		fmt.Printf("%s Removed kubeconfig %s\n", ui.Green("✓"), ui.ShortPath(kubePath))
	}

	if repoRoot != "" {
		gitutil.PruneWorktrees(repoRoot)
	}

	return nil
}
