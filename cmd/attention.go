package cmd

import (
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/mturley/worktree/internal/attention"
	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

// attentionTextEvents is how many of an item's events the text output shows.
const attentionTextEvents = 3

var (
	attentionWorktree string
	attentionJSON     bool
)

var attentionCmd = &cobra.Command{
	Use:   "attention",
	Short: "Show what deserves attention, most important first",
	Long: "Show each resource with unread events or a named signal, and each task due\n" +
		"soon or newly unblocked, in a fixed order: priority, then number of signals,\n" +
		"then newest activity. Read straight from the database: no server or login\n" +
		"needed, but new activity only arrives while `worktree ui` is running and polling.\n\n" +
		"Signals: review_requested, changes_requested, ci_failing, assigned_to_you,\n" +
		"mentioned, stale_draft, task_due_soon, blocker_resolved.\n\n" +
		"With no --worktree it covers every worktree, even when run inside one.\n" +
		"--worktree . narrows it to the current worktree.\n\n" +
		"Exits 1 when nothing needs attention.",
	Example: "  worktree attention\n" +
		"  worktree attention --json\n" +
		"  worktree attention --worktree .",
	GroupID: "worktree",
	Args:    cobra.NoArgs,
	RunE:    runAttention,
	// Execute prints errors itself; cobra would otherwise add "Error:" and
	// the usage text, including for ErrNothingFound.
	SilenceUsage:  true,
	SilenceErrors: true,
}

func init() {
	f := attentionCmd.Flags()
	f.StringVar(&attentionWorktree, "worktree", "", `only this worktree's items ("." for the current one)`)
	f.BoolVar(&attentionJSON, "json", false, `print {"schema_version": 1, "items": [...], "status": {...}}`)
	rootCmd.AddCommand(attentionCmd)
}

func runAttention(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	conn, err := wdb.OpenRead()
	if err != nil {
		return err
	}
	defer conn.Close()
	var path string
	if attentionWorktree != "" {
		if path, err = resolveWorktreeFlag(conn, attentionWorktree); err != nil {
			return err
		}
	}
	srv, err := headlessServer(conn)
	if err != nil {
		return err
	}
	resources, tasks, linkedJira, self, err := srv.AttentionInput(path)
	if err != nil {
		return err
	}
	now := time.Now()
	items := attention.Build(now, self, resources, tasks, linkedJira)
	status, err := buildStatus(conn, cfg, now)
	if err != nil {
		return err
	}

	out := cmd.OutOrStdout()
	if attentionJSON {
		if err := printJSON(out, map[string]any{"items": items, "status": status.fields()}); err != nil {
			return err
		}
	} else {
		printAttention(out, items, status.Stale)
	}
	if len(items) == 0 {
		return ErrNothingFound
	}
	return nil
}

// printAttention renders the text output: the stale hint when it applies,
// then for each item a header line and up to attentionTextEvents event lines.
func printAttention(w io.Writer, items []attention.Item, stale bool) {
	if stale {
		fmt.Fprintln(w, staleHint)
	}
	if len(items) == 0 {
		fmt.Fprintln(w, "Nothing needs your attention.")
		return
	}
	for _, it := range items {
		fmt.Fprintf(w, "[%s] %s", attentionRankLabel(it), ui.Bold(attentionTitle(it)))
		if len(it.Signals) > 0 {
			fmt.Fprintf(w, "  %s", ui.Yellow(strings.Join(it.Signals, ", ")))
		}
		fmt.Fprintln(w)
		for _, e := range it.Events[:min(len(it.Events), attentionTextEvents)] {
			fmt.Fprintln(w, "  "+attentionEventLine(e))
		}
	}
}

// attentionRankLabel is "<rank> <name>", either part left out when unknown
// (a PR's inherited rank has no name), or "-" when neither is known.
func attentionRankLabel(it attention.Item) string {
	var name string
	switch {
	case it.Task != nil && it.Task.Priority != "none":
		name = it.Task.Priority
	case it.Resource != nil:
		name = it.Resource.Priority
	}
	parts := []string{}
	if it.Rank != nil {
		parts = append(parts, strconv.Itoa(*it.Rank))
	}
	if name != "" {
		parts = append(parts, name)
	}
	if len(parts) == 0 {
		return "-"
	}
	return strings.Join(parts, " ")
}

func attentionTitle(it attention.Item) string {
	if it.Task != nil {
		return it.Task.Title
	}
	r := it.Resource
	switch {
	case r.CustomName != "":
		return r.CustomName
	case r.Title != "":
		return r.Title
	}
	return r.ID
}

// attentionEventLine is "<local time>  <author>: <title>".
func attentionEventLine(e attention.Event) string {
	when := e.TS
	if t, err := time.Parse(time.RFC3339, e.TS); err == nil {
		when = t.Local().Format("2006-01-02 15:04")
	}
	text := e.Title
	if e.Author != "" {
		text = e.Author + ": " + text
	}
	return when + "  " + text
}
