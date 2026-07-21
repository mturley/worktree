package cmd

import (
	"fmt"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/discovery"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

var listCmd = &cobra.Command{
	Use:     "list",
	Short:   "List all discovered worktrees",
	GroupID: "worktree",
	RunE:    runList,
}

func init() {
	rootCmd.AddCommand(listCmd)
}

func runList(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("loading config: %w", err)
	}

	groups, err := discovery.Discover(cfg.Search.Roots, cfg.Search.Depth, cfg.Search.Prune)
	if err != nil {
		return fmt.Errorf("discovering worktrees: %w", err)
	}

	if len(groups) == 0 {
		fmt.Println("No worktrees found.")
		fmt.Printf("Search roots: %v\n", cfg.Search.Roots)
		return nil
	}

	cmuxDirs := make(map[string]bool)
	if cmux.IsAvailable() {
		if workspaces, err := cmux.ListWorkspaces(); err == nil {
			for _, ws := range workspaces {
				if ws.CurrentDirectory != "" {
					cmuxDirs[ws.CurrentDirectory] = true
				}
			}
		}
	}

	n := 0
	for _, group := range groups {
		fmt.Printf("\n%s\n", ui.Bold(group.Repo))
		for _, wt := range group.Worktrees {
			n++
			status := ""
			switch wt.Status {
			case "prunable":
				status = " " + ui.Yellow("(prunable)")
			case "missing":
				status = " " + ui.Red("(missing)")
			case "orphaned":
				status = " " + ui.Red("(orphaned)")
			}

			cmuxMarker := ""
			if cmuxDirs[wt.Path] {
				cmuxMarker = " " + ui.Green("[open]")
			}

			branch := wt.Branch
			if branch == "" {
				branch = "(no branch)"
			}

			path := ui.ShortPath(wt.Path)
			fmt.Printf("  %s %s %s%s%s\n",
				ui.Dim(fmt.Sprintf("[%d]", n)),
				ui.Cyan(branch),
				ui.Dim(path),
				status,
				cmuxMarker,
			)
		}
	}
	fmt.Println()
	return nil
}
