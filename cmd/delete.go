package cmd

import (
	"fmt"
	"os"
	"path/filepath"

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
		ui.SpinWhile("Removing worktree", func() error {
			return gitutil.RemoveWorktree(repoRoot, wtPath)
		})
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
