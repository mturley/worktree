package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

var infoLocal bool

var infoCmd = &cobra.Command{
	Use:     "info [path]",
	Short:   "Show worktree info",
	GroupID: "worktree",
	RunE:    runInfo,
}

func init() {
	infoCmd.Flags().BoolVar(&infoLocal, "local", false, "Skip API calls (fast)")
	rootCmd.AddCommand(infoCmd)
}

func runInfo(cmd *cobra.Command, args []string) error {
	wtPath, err := resolveWorktreePath(args)
	if err != nil {
		return err
	}

	branch := gitBranch(wtPath)
	tracking := gitTrackingInfo(wtPath)

	fmt.Printf("%s", ui.Bold(branch))
	if tracking != "" {
		fmt.Printf(" %s", ui.Dim(tracking))
	}
	fmt.Println()

	we := readWorktreeEnv(wtPath)
	if we.Path != "" || we.Ports != "" || we.Title != "" || we.Kube != "" {
		sourced := os.Getenv("WORKTREE_PATH") == we.Path
		if sourced {
			fmt.Printf("  %s\n", ui.Dim("Environment variables sourced from .worktree-env:"))
		} else {
			fmt.Printf("  %s\n", ui.Dim("Environment variables defined in .worktree-env:"))
		}
		if we.Path != "" {
			fmt.Printf("    WORKTREE_PATH  = %s\n", ui.ShortPath(we.Path))
		}
		if we.Title != "" {
			fmt.Printf("    WORKTREE_TITLE = %s\n", we.Title)
		}
		if we.Ports != "" {
			fmt.Printf("    WORKTREE_PORTS = %s\n", we.Ports)
		}
		if we.Kube != "" {
			fmt.Printf("    KUBECONFIG     = %s\n", ui.ShortPath(we.Kube))
		}
		if !sourced {
			fmt.Printf("\n  %s .worktree-env is not being sourced in this shell.\n", ui.Yellow("!"))
			fmt.Printf("    Check your shell config or run %s to set up auto-sourcing.\n", ui.Bold("worktree setup"))
		}
	}

	res, _ := resources.Load(wtPath)
	if len(res) > 0 {
		fmt.Println()
		for _, r := range res {
			prefix := " "
			if r.Related {
				prefix = "~"
			}
			fmt.Printf("  %s %s:%s %s\n", ui.Dim(prefix), r.Type, ui.Cyan(r.ID), ui.Dim(r.URL))
		}
	}

	return nil
}

func resolveWorktreePath(args []string) (string, error) {
	if len(args) > 0 {
		return args[0], nil
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(env.FilePath(dir)); err == nil {
		return dir, nil
	}
	toplevel := gitToplevel(dir)
	if toplevel != "" {
		return toplevel, nil
	}
	return dir, nil
}

func readWorktreeEnv(path string) env.WorktreeEnv {
	data, err := os.ReadFile(env.FilePath(path))
	if err != nil {
		return env.WorktreeEnv{}
	}
	var we env.WorktreeEnv
	for _, line := range strings.Split(string(data), "\n") {
		if v, ok := parseExport(line, "WORKTREE_PORTS"); ok {
			we.Ports = v
		}
		if v, ok := parseExport(line, "WORKTREE_TITLE"); ok {
			we.Title = v
		}
		if v, ok := parseExport(line, "WORKTREE_PATH"); ok {
			we.Path = v
		}
		if v, ok := parseExport(line, "KUBECONFIG"); ok {
			we.Kube = v
		}
	}
	return we
}

func parseExport(line, key string) (string, bool) {
	prefix := "export " + key + "="
	if !strings.HasPrefix(line, prefix) {
		return "", false
	}
	val := strings.TrimPrefix(line, prefix)
	val = strings.Trim(val, "\"")
	return val, true
}

func gitBranch(dir string) string {
	cmd := exec.Command("git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return "(unknown)"
	}
	return strings.TrimSpace(string(out))
}

func gitTrackingInfo(dir string) string {
	cmd := exec.Command("git", "-C", dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	upstream := strings.TrimSpace(string(out))

	cmd = exec.Command("git", "-C", dir, "rev-list", "--left-right", "--count", "HEAD...@{u}")
	countOut, err := cmd.Output()
	if err != nil {
		return fmt.Sprintf("→ %s", upstream)
	}
	parts := strings.Fields(strings.TrimSpace(string(countOut)))
	if len(parts) == 2 {
		return fmt.Sprintf("→ %s (%s ahead, %s behind)", upstream, parts[0], parts[1])
	}
	return fmt.Sprintf("→ %s", upstream)
}

func gitToplevel(dir string) string {
	cmd := exec.Command("git", "-C", dir, "rev-parse", "--show-toplevel")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
