package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"

	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

var openGitHub bool
var openJira bool

var openCmd = &cobra.Command{
	Use:     "open [path]",
	Short:   "Open worktree in editor, or open PR/Jira in browser",
	GroupID: "worktree",
	RunE:    runOpen,
}

func init() {
	openCmd.Flags().BoolVar(&openGitHub, "github", false, "Open the associated PR in the browser")
	openCmd.Flags().BoolVar(&openJira, "jira", false, "Open the associated Jira issue in the browser")
	rootCmd.AddCommand(openCmd)
}

func runOpen(cmd *cobra.Command, args []string) error {
	wtPath, err := resolveWorktreePath(args)
	if err != nil {
		return err
	}

	if openGitHub {
		return openGitHubPR(wtPath)
	}
	if openJira {
		return openJiraIssue(wtPath)
	}
	return openEditor(wtPath)
}

func openEditor(wtPath string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	editor := cfg.Editor
	if editor == "" {
		editor = os.Getenv("EDITOR")
	}
	if editor == "" {
		editor = os.Getenv("VISUAL")
	}

	if editor != "" {
		cmd := exec.Command(editor, wtPath)
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}

	if runtime.GOOS == "darwin" {
		return exec.Command("open", wtPath).Run()
	}

	return fmt.Errorf("no editor configured (set 'editor' in config or $EDITOR)")
}

func openGitHubPR(wtPath string) error {
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	res, err := resources.Load(conn, wtPath)
	if err != nil {
		return err
	}

	pr := resources.PrimaryOfType(res, "pr")
	if pr == nil {
		return fmt.Errorf("no PR associated with this worktree")
	}

	fmt.Printf("Opening %s\n", ui.Cyan(pr.URL))
	return openURL(pr.URL)
}

func openJiraIssue(wtPath string) error {
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	res, err := resources.Load(conn, wtPath)
	if err != nil {
		return err
	}

	jiraRes := resources.OfType(res, "jira")
	if len(jiraRes) == 0 {
		return fmt.Errorf("no Jira issues associated with this worktree")
	}

	if len(jiraRes) == 1 {
		fmt.Printf("Opening %s\n", ui.Cyan(jiraRes[0].URL))
		return openURL(jiraRes[0].URL)
	}

	fmt.Println("Multiple Jira issues associated:")
	for i, r := range jiraRes {
		prefix := " "
		if r.Related {
			prefix = "~"
		}
		fmt.Printf("  %s [%d] %s %s\n", prefix, i+1, ui.Cyan(r.ID), ui.Dim(r.URL))
	}

	choice, err := ui.PromptChoice("Open which issue?", len(jiraRes))
	if err != nil {
		return err
	}
	return openURL(jiraRes[choice-1].URL)
}

func openURL(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Run()
	case "linux":
		return exec.Command("xdg-open", url).Run()
	default:
		fmt.Println(url)
		return nil
	}
}
