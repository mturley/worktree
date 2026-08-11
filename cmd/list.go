package cmd

import (
	"fmt"
	"os"

	"github.com/mturley/worktree/internal/cmux"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

var listCmd = &cobra.Command{
	Use:     "list",
	Short:   "List all managed worktrees",
	GroupID: "worktree",
	RunE:    runList,
}

func init() {
	rootCmd.AddCommand(listCmd)
}

func runList(cmd *cobra.Command, args []string) error {
	conn, err := wdb.Open()
	if err != nil {
		return fmt.Errorf("opening db: %w", err)
	}
	defer conn.Close()

	entries, err := registry.List(conn)
	if err != nil {
		return fmt.Errorf("listing worktrees: %w", err)
	}
	if len(entries) == 0 {
		fmt.Println("No worktrees managed by worktree yet. Create one with `worktree add`.")
		return nil
	}

	cmuxDirs := map[string]bool{}
	if cmux.IsAvailable() {
		if workspaces, err := cmux.ListWorkspaces(); err == nil {
			for _, ws := range workspaces {
				if ws.CurrentDirectory != "" {
					cmuxDirs[ws.CurrentDirectory] = true
				}
			}
		}
	}

	currentRepo := ""
	n := 0
	for _, e := range entries {
		if e.Repo != currentRepo {
			fmt.Printf("\n%s\n", ui.Bold(e.Repo))
			currentRepo = e.Repo
		}
		n++
		missing := ""
		if _, statErr := os.Stat(e.Path); os.IsNotExist(statErr) {
			missing = " " + ui.Red("(missing)")
		}
		cmuxMarker := ""
		if cmuxDirs[e.Path] {
			cmuxMarker = " " + ui.Green("[open]")
		}
		branch := e.Branch
		if branch == "" {
			branch = "(no branch)"
		}
		fmt.Printf("  %s %s %s%s%s\n",
			ui.Dim(fmt.Sprintf("[%d]", n)), ui.Cyan(branch), ui.Dim(ui.ShortPath(e.Path)), missing, cmuxMarker)
	}
	fmt.Println()
	return nil
}
