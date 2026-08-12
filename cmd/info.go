package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/shellenv"
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

	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()

	envLines, _ := shellenv.Lines(conn, wtPath)
	if len(envLines) > 0 {
		sourced := os.Getenv("WORKTREE_PATH") != "" && strings.Contains(strings.Join(envLines, "\n"), fmt.Sprintf("WORKTREE_PATH=%q", os.Getenv("WORKTREE_PATH")))
		if sourced {
			fmt.Printf("  %s\n", ui.Dim("Environment (sourced in this shell):"))
		} else {
			fmt.Printf("  %s\n", ui.Dim("Environment (via eval \"$(worktree env)\"):"))
		}
		for _, l := range envLines {
			fmt.Printf("    %s\n", strings.TrimPrefix(l, "export "))
		}
		if !sourced {
			fmt.Printf("\n  %s worktree env is not being sourced in this shell.\n", ui.Yellow("!"))
			fmt.Printf("    Check your shell config or run %s to set up auto-sourcing.\n", ui.Bold("worktree setup"))
		}
	}

	res, _ := resources.Load(conn, wtPath)
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
	toplevel := gitToplevel(dir)
	if toplevel != "" {
		return toplevel, nil
	}
	return dir, nil
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
