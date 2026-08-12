package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
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

	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()

	res, err := registry.Reconcile(conn, cfg.WorktreesBase)
	if err != nil {
		return err
	}
	if len(res.Stale) == 0 && len(res.Orphans) == 0 {
		fmt.Println("Nothing to clean up.")
		return nil
	}

	if len(res.Stale) > 0 {
		fmt.Println(ui.Bold("Stale registrations (registered but no longer on disk):"))
		for i, path := range res.Stale {
			fmt.Printf("  [%d] %s\n", i+1, ui.Dim(ui.ShortPath(path)))
		}
		fmt.Println("\nEnter numbers to unregister (comma-separated, e.g. 1,3,5), or 'q' to skip:")
		selections, _ := readSelections(len(res.Stale))
		for _, idx := range selections {
			path := res.Stale[idx]
			fmt.Printf("\nUnregistering %s...\n", ui.ShortPath(path))
			if err := registry.Unregister(conn, path); err != nil {
				fmt.Fprintf(os.Stderr, "  Warning: failed to unregister: %v\n", err)
			} else {
				fmt.Printf("  %s Unregistered\n", ui.Green("✓"))
			}
			if err := ports.Release(conn, filepath.Base(path)); err == nil {
				fmt.Printf("  %s Released port range\n", ui.Green("✓"))
			}
			if err := resources.RemoveAll(conn, path); err != nil {
				fmt.Fprintf(os.Stderr, "  Warning: failed to remove tracked resources: %v\n", err)
			}
		}
	}

	if len(res.Orphans) > 0 {
		fmt.Println(ui.Bold("\nOrphaned directories (on disk under worktrees base but unmanaged):"))
		for i, path := range res.Orphans {
			fmt.Printf("  [%d] %s\n", i+1, ui.Dim(ui.ShortPath(path)))
		}
		fmt.Println("\nEnter numbers to delete from disk (comma-separated, e.g. 1,3,5), or 'q' to skip:")
		selections, _ := readSelections(len(res.Orphans))
		for _, idx := range selections {
			path := res.Orphans[idx]
			fmt.Printf("\n%s Delete %s from disk? [y/N] ", ui.Yellow("!"), ui.ShortPath(path))
			if !confirmYes() {
				fmt.Println("  Skipped.")
				continue
			}
			if err := os.RemoveAll(path); err != nil {
				fmt.Fprintf(os.Stderr, "  Warning: failed to remove: %v\n", err)
			} else {
				fmt.Printf("  %s Removed directory\n", ui.Green("✓"))
			}
		}
	}

	fmt.Printf("\n%s Cleanup complete\n", ui.Green("✓"))
	return nil
}

func confirmYes() bool {
	var input string
	fmt.Scanln(&input)
	return input == "y" || input == "Y" || input == "yes"
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
