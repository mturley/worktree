package cmd

import (
	"fmt"
	"path/filepath"

	"github.com/mturley/worktree/internal/dotfiles"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

var dotfilesCmd = &cobra.Command{
	Use:     "dotfiles [path]",
	Short:   "Copy gitignored dotfiles from the main worktree",
	GroupID: "worktree",
	RunE:    runDotfiles,
}

func init() {
	rootCmd.AddCommand(dotfilesCmd)
}

func runDotfiles(cmd *cobra.Command, args []string) error {
	wtPath, err := resolveWorktreePath(args)
	if err != nil {
		return err
	}

	repoRoot, err := findMainWorktree(wtPath)
	if err != nil {
		return fmt.Errorf("cannot find main worktree: %w", err)
	}

	dfs, err := dotfiles.Discover(repoRoot)
	if err != nil {
		return err
	}

	if len(dfs) == 0 {
		fmt.Println("No gitignored dotfiles found in main worktree.")
		return nil
	}

	fmt.Printf("Found %d gitignored dotfiles in %s:\n", len(dfs), ui.ShortPath(repoRoot))
	for _, df := range dfs {
		kind := "file"
		if df.IsDir {
			kind = "dir"
		}
		fmt.Printf("  %s %s\n", ui.Dim(kind), df.Name)
	}

	if !ui.Confirm("\nCopy these dotfiles?") {
		return nil
	}

	for _, df := range dfs {
		if err := dotfiles.Copy(df.Path, wtPath, df); err != nil {
			fmt.Fprintf(cmd.ErrOrStderr(), "  Warning: failed to copy %s: %v\n", df.Name, err)
		} else {
			fmt.Printf("  %s %s\n", ui.Green("✓"), df.Name)
		}
	}
	return nil
}

func findMainWorktree(wtPath string) (string, error) {
	commonDir := gitutil.CommonDir(wtPath)
	if commonDir == "" {
		return "", fmt.Errorf("not a git directory")
	}
	if commonDir == ".git" {
		return wtPath, nil
	}
	// commonDir is an absolute path to the main repo's .git dir
	return filepath.Dir(commonDir), nil
}
