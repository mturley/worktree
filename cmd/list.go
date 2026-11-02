package cmd

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	"github.com/mturley/worktree/internal/cmux"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/ui"
	"github.com/mturley/worktree/internal/webui"
	"github.com/spf13/cobra"
)

var listCmd = &cobra.Command{
	Use:     "list",
	Short:   "List all managed worktrees",
	GroupID: "worktree",
	RunE:    runList,
}

var (
	worktreeListJSON bool
	worktreeListGit  bool
)

func init() {
	listCmd.Flags().BoolVar(&worktreeListJSON, "json", false, "machine-readable JSON output")
	listCmd.Flags().BoolVar(&worktreeListGit, "git", false, "with --json, add each on-disk worktree's git state (runs git per worktree)")
	rootCmd.AddCommand(listCmd)
}

// openInCmux reports, for each path, whether a cmux workspace is open in it.
// Everything is false outside cmux.
func openInCmux(paths []string) map[string]bool {
	out := map[string]bool{}
	if !cmux.IsAvailable() {
		return out
	}
	workspaces, err := cmux.ListWorkspaces()
	if err != nil {
		return out
	}
	for p, hits := range cmux.Match(workspaces, paths) {
		out[p] = len(hits) > 0
	}
	return out
}

// listWorktreeJSON is one worktrees[] entry of `list --json`.
type listWorktreeJSON struct {
	webui.WorktreeSummary
	Name string `json:"name"` // the directory's base name
	// Shadows the summary's own: mapped through resourceItem so updated_at
	// means what it means in every other output.
	FocusResources []map[string]any `json:"focus_resources"`
	OpenInCmux     bool             `json:"open_in_cmux"`
	Git            *gitState        `json:"git,omitempty"`
}

func runListJSON(cmd *cobra.Command, conn *sql.DB) error {
	srv, err := headlessServer(conn)
	if err != nil {
		return err
	}
	summaries, err := srv.WorktreeSummaries()
	if err != nil {
		return fmt.Errorf("listing worktrees: %w", err)
	}
	paths := make([]string, 0, len(summaries))
	for _, s := range summaries {
		paths = append(paths, s.Path)
	}
	open := openInCmux(paths)
	out := make([]listWorktreeJSON, 0, len(summaries))
	for _, s := range summaries {
		meta := metaTimes(conn, s.Path)
		focus := make([]map[string]any, 0, len(s.FocusResources))
		for _, d := range s.FocusResources {
			fi, err := resourceItem(d, meta[[2]string{d.Type, d.ID}])
			if err != nil {
				return err
			}
			focus = append(focus, fi)
		}
		item := listWorktreeJSON{WorktreeSummary: s, Name: filepath.Base(s.Path), FocusResources: focus, OpenInCmux: open[s.Path]}
		if worktreeListGit && s.OnDisk {
			if g, ok := readGitState(s.Path); ok {
				item.Git = &g
			}
		}
		out = append(out, item)
	}
	return printJSON(cmd.OutOrStdout(), map[string]any{"worktrees": out})
}

func runList(cmd *cobra.Command, args []string) error {
	conn, err := wdb.OpenRead()
	if err != nil {
		return err
	}
	defer conn.Close()

	if worktreeListJSON {
		return runListJSON(cmd, conn)
	}

	entries, err := registry.List(conn)
	if err != nil {
		return fmt.Errorf("listing worktrees: %w", err)
	}
	if len(entries) == 0 {
		fmt.Println("No worktrees managed by worktree yet. Create one with `worktree add`.")
		return nil
	}

	paths := make([]string, 0, len(entries))
	for _, e := range entries {
		paths = append(paths, e.Path)
	}
	cmuxDirs := openInCmux(paths)

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
