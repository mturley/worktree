package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/shellenv"
	"github.com/mturley/worktree/internal/ui"
	"github.com/mturley/worktree/internal/webui"
	"github.com/spf13/cobra"
)

var infoJSON bool

var infoCmd = &cobra.Command{
	Use:     "info [path]",
	Short:   "Show worktree info",
	Long:    "Show a worktree's git state, environment and tracked resources. Resources show the state cached by the watchers; nothing here contacts GitHub, Jira or Slack.",
	GroupID: "worktree",
	RunE:    runInfo,
}

func init() {
	infoCmd.Flags().BoolVar(&infoJSON, "json", false, "machine-readable JSON output")
	rootCmd.AddCommand(infoCmd)
}

// envMap turns shellenv's `export NAME=VALUE` lines into a map.
func envMap(lines []string) map[string]string {
	out := make(map[string]string, len(lines))
	for _, l := range lines {
		name, val, ok := strings.Cut(strings.TrimPrefix(l, "export "), "=")
		if !ok {
			continue
		}
		if u, err := strconv.Unquote(val); err == nil {
			val = u
		}
		out[name] = val
	}
	return out
}

// cachedStateSummary is the short cached-state suffix `info` prints after a
// resource's id: PR state, review decision and CI; Jira status and priority.
func cachedStateSummary(r webui.ResourceDTO) string {
	var parts []string
	add := func(v string) {
		if v != "" {
			parts = append(parts, v)
		}
	}
	switch r.Type {
	case "pr":
		add(r.State)
		add(r.ReviewDecision)
		if r.CIStatus != "" {
			add("CI " + r.CIStatus)
		}
	case "jira":
		add(r.Status)
		add(r.Priority)
	}
	if len(parts) == 0 {
		return ""
	}
	return "(" + strings.Join(parts, ", ") + ")"
}

func runInfo(cmd *cobra.Command, args []string) error {
	w := cmd.OutOrStdout()
	wtPath, err := resolveWorktreePath(args)
	if err != nil {
		return err
	}

	conn, err := wdb.OpenRead()
	if err != nil {
		return err
	}
	defer conn.Close()
	srv, err := headlessServer(conn)
	if err != nil {
		return err
	}

	git, gitOK := readGitState(wtPath)
	envLines, err := shellenv.Lines(conn, wtPath)
	if err != nil {
		return err
	}
	dtos, err := srv.WorktreeResources(wtPath)
	if err != nil {
		return err
	}

	if infoJSON {
		meta := metaTimes(conn, wtPath)
		items := make([]map[string]any, 0, len(dtos))
		for _, d := range dtos {
			item, err := resourceItem(d, meta[[2]string{d.Type, d.ID}])
			if err != nil {
				return err
			}
			items = append(items, item)
		}
		wt := struct {
			Path string `json:"path"`
			// Omitted when the worktree is not on disk (or git cannot read it).
			*gitState
			Env       map[string]string `json:"env"`
			Resources []map[string]any  `json:"resources"`
		}{Path: wtPath, Env: envMap(envLines), Resources: items}
		if gitOK {
			wt.gitState = &git
		}
		return printJSON(cmd.OutOrStdout(), map[string]any{"worktree": wt})
	}

	switch {
	case !onDisk(wtPath):
		fmt.Fprintf(w, "%s %s\n", ui.Bold(ui.ShortPath(wtPath)), ui.Red("(not on disk)"))
	case !gitOK:
		fmt.Fprintf(w, "%s\n", ui.Bold("(unknown)"))
	default:
		fmt.Fprintf(w, "%s", ui.Bold(git.Branch))
		if git.Upstream != "" {
			fmt.Fprintf(w, " %s", ui.Dim(fmt.Sprintf("→ %s (%d ahead, %d behind)", git.Upstream, git.Ahead, git.Behind)))
		}
		fmt.Fprintln(w)
	}

	if len(envLines) > 0 {
		sourced := os.Getenv("WORKTREE_PATH") != "" && strings.Contains(strings.Join(envLines, "\n"), fmt.Sprintf("WORKTREE_PATH=%q", os.Getenv("WORKTREE_PATH")))
		if sourced {
			fmt.Fprintf(w, "  %s\n", ui.Dim("Environment (sourced in this shell):"))
		} else {
			fmt.Fprintf(w, "  %s\n", ui.Dim("Environment (via eval \"$(worktree env)\"):"))
		}
		for _, l := range envLines {
			fmt.Fprintf(w, "    %s\n", strings.TrimPrefix(l, "export "))
		}
		if !sourced {
			fmt.Fprintf(w, "\n  %s worktree env is not being sourced in this shell.\n", ui.Yellow("!"))
			fmt.Fprintf(w, "    Check your shell config or run %s to set up auto-sourcing.\n", ui.Bold("worktree setup"))
		}
	}

	if len(dtos) > 0 {
		fmt.Fprintln(w)
		for _, r := range dtos {
			prefix := " "
			if !r.Primary {
				prefix = "~"
			}
			state := ""
			if s := cachedStateSummary(r); s != "" {
				state = " " + s
			}
			fmt.Fprintf(w, "  %s %s:%s%s %s\n", ui.Dim(prefix), r.Type, ui.Cyan(r.ID), state, ui.Dim(r.URL))
		}
	}

	return nil
}

// resolveWorktreePath returns the absolute path of the worktree named by args,
// or of the one containing the working directory when args is empty.
//
// An explicit empty argument is an error rather than "no argument": passed on
// to git as `-C ""` it silently means the working directory, which is how
// `worktree delete ""` once went after the branch of whatever repo it was run
// from.
func resolveWorktreePath(args []string) (string, error) {
	if len(args) > 0 {
		if strings.TrimSpace(args[0]) == "" {
			return "", fmt.Errorf("worktree path is empty")
		}
		return filepath.Abs(args[0])
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	toplevel := gitToplevel(dir)
	if toplevel != "" {
		return toplevel, nil
	}
	return dir, nil
}

func gitToplevel(dir string) string {
	cmd := exec.Command("git", "-C", dir, "rev-parse", "--show-toplevel")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
