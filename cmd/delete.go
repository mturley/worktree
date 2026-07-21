package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/ports"
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
		if err := gitutil.RemoveWorktree(repoRoot, wtPath); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: git worktree remove failed: %v\n", err)
		} else {
			fmt.Printf("%s Removed worktree\n", ui.Green("✓"))
		}
	}

	if err := ports.Release(cfg.WorktreesBase, wtName); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to release port range: %v\n", err)
	} else {
		fmt.Printf("%s Released port range\n", ui.Green("✓"))
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
