package cmd

import (
	"fmt"
	"path/filepath"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/discovery"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

var pruneCmd = &cobra.Command{
	Use:     "prune",
	Short:   "Clean up stale port allocations and git worktree state",
	Long:    "Remove port allocations for worktrees that no longer exist and prune git's internal worktree tracking. Use after manually deleting a worktree directory.",
	GroupID: "worktree",
	RunE:    runPrune,
}

func init() {
	rootCmd.AddCommand(pruneCmd)
}

func runPrune(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	allocs, err := ports.LoadAllocations(cfg.WorktreesBase)
	if err != nil {
		return err
	}

	liveNames := make(map[string]bool)
	groups, _ := discovery.Discover(cfg.Search.Roots, cfg.Search.Depth, cfg.Search.Prune)
	for _, g := range groups {
		for _, wt := range g.Worktrees {
			liveNames[filepath.Base(wt.Path)] = true
		}
	}

	pruned := 0
	for _, a := range allocs {
		if !liveNames[a.Name] {
			ports.Release(cfg.WorktreesBase, a.Name)
			fmt.Printf("  %s Released stale port range %s (%s)\n", ui.Green("✓"), a.Range(), a.Name)
			pruned++
		}
	}

	if root, err := findRepoRoot(); err == nil {
		gitutil.PruneWorktrees(root)
		fmt.Printf("  %s Pruned git worktree state\n", ui.Green("✓"))
	}

	if pruned == 0 {
		fmt.Println("  Nothing to prune.")
	}

	return nil
}
