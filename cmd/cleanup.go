package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/discovery"
	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

var cleanupCmd = &cobra.Command{
	Use:     "cleanup",
	Short:   "Interactive worktree cleanup",
	GroupID: "worktree",
	RunE:    runCleanup,
}

func init() {
	rootCmd.AddCommand(cleanupCmd)
}

func runCleanup(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	groups, err := discovery.Discover(cfg.Search.Roots, cfg.Search.Depth, cfg.Search.Prune)
	if err != nil {
		return err
	}

	var allWTs []discovery.Worktree
	for _, g := range groups {
		for _, wt := range g.Worktrees {
			if wt.IsBare {
				continue
			}
			allWTs = append(allWTs, wt)
		}
	}

	if len(allWTs) == 0 {
		fmt.Println("No worktrees found.")
		return nil
	}

	conn, err := wdb.Open()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to open worktree db: %v\n", err)
	}
	if conn != nil {
		defer conn.Close()
	}

	fmt.Println(ui.Bold("Discovered worktrees:"))
	for i, wt := range allWTs {
		status := ""
		switch wt.Status {
		case "prunable":
			status = " " + ui.Yellow("(prunable)")
		case "missing":
			status = " " + ui.Red("(missing)")
		case "orphaned":
			status = " " + ui.Red("(orphaned)")
		}
		fmt.Printf("  [%d] %s %s %s%s\n",
			i+1,
			ui.Dim(wt.Repo),
			ui.Cyan(wt.Branch),
			ui.Dim(ui.ShortPath(wt.Path)),
			status,
		)
	}

	fmt.Println("\nEnter numbers to remove (comma-separated, e.g. 1,3,5), or 'q' to quit:")
	selections, err := readSelections(len(allWTs))
	if err != nil || len(selections) == 0 {
		fmt.Println("No worktrees selected.")
		return nil
	}

	for _, idx := range selections {
		wt := allWTs[idx]
		fmt.Printf("\nRemoving %s (%s)...\n", ui.Cyan(wt.Branch), ui.ShortPath(wt.Path))

		if wt.RepoRoot != "" {
			if err := gitutil.RemoveWorktree(wt.RepoRoot, wt.Path); err != nil {
				fmt.Fprintf(os.Stderr, "  Warning: %v\n", err)
			} else {
				fmt.Printf("  %s Removed worktree\n", ui.Green("✓"))
			}
		}

		wtName := filepath.Base(wt.Path)
		if conn != nil {
			if err := ports.Release(conn, wtName); err == nil {
				fmt.Printf("  %s Released port range\n", ui.Green("✓"))
			}
			if err := registry.Unregister(conn, wt.Path); err != nil {
				fmt.Fprintf(os.Stderr, "  Warning: failed to unregister worktree: %v\n", err)
			}
		}

		repoName := filepath.Base(wt.RepoRoot)
		kubePath := env.KubeconfigPath(repoName, wtName)
		if err := os.Remove(kubePath); err == nil {
			fmt.Printf("  %s Removed kubeconfig\n", ui.Green("✓"))
		}

		if wt.RepoRoot != "" {
			gitutil.PruneWorktrees(wt.RepoRoot)
		}
	}

	fmt.Printf("\n%s Cleanup complete\n", ui.Green("✓"))
	return nil
}

func readSelections(max int) ([]int, error) {
	var input string
	fmt.Print("> ")
	fmt.Scanln(&input)

	if input == "q" || input == "" {
		return nil, nil
	}

	var indices []int
	seen := make(map[int]bool)

	for _, part := range splitCSV(input) {
		n := 0
		fmt.Sscanf(part, "%d", &n)
		if n >= 1 && n <= max && !seen[n-1] {
			seen[n-1] = true
			indices = append(indices, n-1)
		}
	}
	return indices, nil
}

func splitCSV(s string) []string {
	var parts []string
	for _, p := range filepath.SplitList(s) {
		parts = append(parts, p)
	}
	if len(parts) <= 1 {
		// filepath.SplitList uses OS path separator; fall back to comma split
		parts = nil
		for _, p := range split(s, ',') {
			parts = append(parts, p)
		}
	}
	return parts
}

func split(s string, sep byte) []string {
	var parts []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == sep {
			parts = append(parts, s[start:i])
			start = i + 1
		}
	}
	parts = append(parts, s[start:])
	return parts
}
