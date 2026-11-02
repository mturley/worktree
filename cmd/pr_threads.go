package cmd

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/setup"
	"github.com/mturley/worktree/internal/webui"
	"github.com/spf13/cobra"
)

// buildServer builds the Server the live read commands call into. Tests
// replace it to stub GitHub, Jira and Slack through the Server's seams.
var buildServer = headlessServer

var (
	prThreadsWorktree string
	prThreadsAll      bool
	prThreadsJSON     bool
)

var prThreadsCmd = &cobra.Command{
	Use:     "pr-threads",
	Short:   "Review threads on a worktree's pull request",
	GroupID: "worktree",
}

var prThreadsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the review threads on the worktree's own PR (contacts GitHub)",
	Long: "List the review threads on the open PR the worktree's branch is on, as the\n" +
		"diff view shows them. This contacts GitHub (cached for a minute) and refuses,\n" +
		"exit 2, while the GitHub watcher is off or no token is configured. It never\n" +
		"marks anything read.\n\n" +
		"Only open threads unless --all. Exits 1 when the branch has no open PR.",
	Example: "  worktree pr-threads list\n" +
		"  worktree pr-threads list --all --json",
	Args:          cobra.NoArgs,
	RunE:          runPRThreadsList,
	SilenceUsage:  true,
	SilenceErrors: true,
}

func init() {
	f := prThreadsListCmd.Flags()
	f.StringVar(&prThreadsWorktree, "worktree", "", "the worktree (default: the current one)")
	f.BoolVar(&prThreadsAll, "all", false, "include resolved threads")
	f.BoolVar(&prThreadsJSON, "json", false, `print {"schema_version": 1, "pr": {...}|null, "threads": [...]}`)
	prThreadsCmd.AddCommand(prThreadsListCmd)
	rootCmd.AddCommand(prThreadsCmd)
}

func runPRThreadsList(cmd *cobra.Command, args []string) error {
	conn, err := wdb.OpenRead()
	if err != nil {
		return err
	}
	defer conn.Close()
	path, err := perWorktreePath(conn, prThreadsWorktree)
	if err != nil {
		return err
	}
	srv, err := buildServer(conn)
	if err != nil {
		return err
	}
	res, err := srv.PRThreads(path)
	if err != nil {
		return err
	}
	switch res.State {
	case "off":
		return errors.New(setup.WatcherOffMessage(config.ServiceGitHub))
	case "no_token":
		return errors.New("no GitHub token is configured; add one in Settings (worktree ui) or run `worktree setup`")
	case "error":
		return errors.New(res.Message)
	}

	out := cmd.OutOrStdout()
	threads := make([]webui.PRThread, 0, len(res.Threads))
	for _, th := range res.Threads {
		if prThreadsAll || !th.Resolved {
			threads = append(threads, th)
		}
	}
	if prThreadsJSON {
		if err := printJSON(out, map[string]any{"pr": res.PR, "threads": threads}); err != nil {
			return err
		}
	} else if res.State == "no_pr" {
		fmt.Fprintln(out, "no open PR for this worktree's branch")
	} else {
		printPRThreads(out, res, threads)
	}
	if res.State == "no_pr" {
		return ErrNothingFound
	}
	return nil
}

func printPRThreads(w io.Writer, res webui.PRThreadsResponse, threads []webui.PRThread) {
	if res.PR != nil {
		fmt.Fprintf(w, "PR #%d %s\n%s\n", res.PR.Number, res.PR.Title, res.PR.URL)
	}
	if len(threads) == 0 {
		fmt.Fprintln(w, "No open review threads.")
		return
	}
	for _, th := range threads {
		state := "open"
		switch {
		case th.Resolved:
			state = "resolved"
		case th.Outdated:
			state = "outdated"
		}
		loc := th.File
		if th.StartLine > 0 {
			loc = fmt.Sprintf("%s:%d", th.File, th.StartLine)
			if th.EndLine > th.StartLine {
				loc += fmt.Sprintf("-%d", th.EndLine)
			}
		}
		fmt.Fprintf(w, "\n[%s] %s\n", state, loc)
		for _, c := range th.Comments {
			body := strings.ReplaceAll(strings.TrimSpace(c.Body), "\n", "\n    ")
			fmt.Fprintf(w, "  %s: %s\n", c.Author, body)
		}
	}
}
