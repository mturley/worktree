package cmd

import (
	"database/sql"
	"fmt"
	"io"
	"os"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/resourceurl"
	"github.com/mturley/worktree/internal/unread"
	"github.com/spf13/cobra"
)

// listResourcesJSON prints `resources list --json`. Items are the web UI's
// resource DTO (cached watcher state included); see resourceItem for how
// updated_at keeps its custom-name meaning for agent-handler.
func listResourcesJSON(w io.Writer, conn *sql.DB, wt string, all bool) error {
	srv, err := headlessServer(conn)
	if err != nil {
		return err
	}
	items := []map[string]any{} // [] not null when empty
	if all {
		rs, err := srv.AllResources()
		if err != nil {
			return err
		}
		meta := map[string]map[[2]string]string{} // by worktree path
		for _, r := range rs {
			var at string
			if len(r.Worktrees) > 0 {
				p := r.Worktrees[0].Path
				if meta[p] == nil {
					meta[p] = metaTimes(conn, p)
				}
				at = meta[p][[2]string{r.Type, r.ID}]
			}
			item, err := resourceItem(r, at)
			if err != nil {
				return err
			}
			items = append(items, item)
		}
		return printJSON(w, map[string]any{"resources": items})
	}
	dtos, err := srv.WorktreeResources(wt)
	if err != nil {
		return err
	}
	meta := metaTimes(conn, wt)
	for _, d := range dtos {
		item, err := resourceItem(d, meta[[2]string{d.Type, d.ID}])
		if err != nil {
			return err
		}
		items = append(items, item)
	}
	return printJSON(w, map[string]any{"resources": items})
}

// writeResourceLines renders the human-readable listing. Split out from
// runResourcesList so it can be tested without a DB or a cobra command.
//
// The unread suffix appears ONLY for a non-zero count, so a fully read
// resource prints exactly the line this command has always printed.
func writeResourceLines(out io.Writer, rs []resources.Resource, counts map[string]int) {
	for _, r := range rs {
		marker := " "
		if r.Related {
			marker = "~"
		}
		suffix := ""
		if n := counts[unread.Key(r.Type, r.ID)]; n > 0 {
			suffix = fmt.Sprintf(" (%d unread)", n)
		}
		fmt.Fprintf(out, "%s %s:%s %s%s\n", marker, r.Type, r.ID, r.URL, suffix)
	}
}

var (
	resWorktree     string
	resJSON         bool
	resAll          bool
	resURL          string
	resRelated      bool
	resName         string
	resDescription  string
	resUpdatedAt    string
	resThrough      string
	resMarkWorktree string
	resMarkAll      bool
	resMarkJSON     bool
)

var resourcesCmd = &cobra.Command{
	Use:     "resources",
	Short:   "Manage resources tracked by a worktree",
	GroupID: "worktree",
}

var resourcesListCmd = &cobra.Command{
	Use:   "list",
	Short: "List tracked resources",
	RunE:  runResourcesList,
}

var resourcesAddCmd = &cobra.Command{
	Use:   "add <url> | <type> <id>",
	Short: "Track a resource, by URL or by explicit type and id",
	Args:  cobra.RangeArgs(1, 2),
	RunE:  runResourcesAdd,
}

var resourcesUnwatchCmd = &cobra.Command{
	Use:   "unwatch <type> <id>",
	Short: "Soft-unsubscribe from a resource (user tombstone)",
	Args:  cobra.ExactArgs(2),
	RunE:  runResourcesUnwatch,
}

var resourcesRemoveCmd = &cobra.Command{
	Use:   "remove <type> <id>",
	Short: "Hard-remove a resource",
	Args:  cobra.ExactArgs(2),
	RunE:  runResourcesRemove,
}

var resourcesSetNameCmd = &cobra.Command{
	Use:   "set-name <type> <id>",
	Short: "Set a resource's custom name/description",
	Long: "Set a resource's user-supplied custom name (and optional description). " +
		"An empty --name clears the name. --updated-at supplies an explicit " +
		"timestamp for cross-database replication; when omitted the write is " +
		"stamped with the current time.",
	Args: cobra.ExactArgs(2),
	RunE: runResourcesSetName,
}

var resourcesMarkReadCmd = &cobra.Command{
	Use:   "mark-read <type> <id>",
	Short: "Mark a resource's events read up to a timestamp",
	Long: "Moves the resource's read cursor. With no --through, marks read through " +
		"the resource's newest event.\n\n" +
		"The cursor is per RESOURCE, not per worktree: marking a PR read clears it " +
		"for every worktree tracking it.\n\n" +
		"With --worktree <path>, marks every non-Slack resource that worktree follows read, " +
		"each through its own newest unread event; --all does the same for every followed " +
		"resource. Because the cursor is per resource and shared, a resource another worktree " +
		"also follows is cleared there too. Slack threads are skipped (their read state is " +
		"Slack's), and so are unread task events, which clear through each task's own cursor. " +
		"--worktree, --all and the positional resource are mutually exclusive.",
	Example: "  worktree resources mark-read pr opendatahub-io/odh-dashboard#123\n" +
		"  worktree resources mark-read --worktree .\n" +
		"  worktree resources mark-read --all --json",
	Args: cobra.MaximumNArgs(2),
	RunE: runResourcesMarkRead,
}

func init() {
	resourcesListCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesListCmd.Flags().BoolVar(&resJSON, "json", false, "machine-readable JSON output")
	resourcesListCmd.Flags().BoolVar(&resAll, "all", false, "list every resource followed by any worktree, once each, with the worktrees following it (JSON only)")
	resourcesAddCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesAddCmd.Flags().StringVar(&resURL, "url", "", "resource URL")
	resourcesAddCmd.Flags().BoolVar(&resRelated, "related", false, "mark as related (not primary)")
	resourcesUnwatchCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesRemoveCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesSetNameCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesSetNameCmd.Flags().StringVar(&resName, "name", "", "custom name (empty clears it)")
	resourcesSetNameCmd.Flags().StringVar(&resDescription, "description", "", "custom description")
	resourcesSetNameCmd.Flags().StringVar(&resUpdatedAt, "updated-at", "", "explicit RFC3339 timestamp for replication (default: now)")
	resourcesMarkReadCmd.Flags().StringVar(&resMarkWorktree, "worktree", "", `mark every non-Slack resource this worktree follows ("." for the current one)`)
	resourcesMarkReadCmd.Flags().BoolVar(&resMarkAll, "all", false, "mark every followed non-Slack resource")
	resourcesMarkReadCmd.Flags().BoolVar(&resMarkJSON, "json", false, `with --worktree/--all, print {"schema_version": 1, "marked": n, "skipped_slack": n, "task_events_remaining": n}`)
	resourcesMarkReadCmd.Flags().StringVar(&resThrough, "through", "", "RFC3339 timestamp to mark read through (default: the resource's newest event)")

	resourcesCmd.AddCommand(resourcesListCmd, resourcesAddCmd, resourcesUnwatchCmd, resourcesRemoveCmd, resourcesSetNameCmd, resourcesMarkReadCmd)
	rootCmd.AddCommand(resourcesCmd)
}

func resourceWorktreePath() (string, error) {
	if resWorktree != "" {
		return resWorktree, nil
	}
	return os.Getwd()
}

func runResourcesList(cmd *cobra.Command, args []string) error {
	if resAll && resWorktree != "" {
		return fmt.Errorf("--all and --worktree are mutually exclusive")
	}
	if resAll && !resJSON {
		return fmt.Errorf("--all requires --json")
	}
	wt, err := resourceWorktreePath()
	if err != nil {
		return err
	}
	conn, err := wdb.OpenRead()
	if err != nil {
		return err
	}
	defer conn.Close()
	if resJSON {
		return listResourcesJSON(cmd.OutOrStdout(), conn, wt, resAll)
	}
	rs, err := resources.Load(conn, wt)
	if err != nil {
		return err
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		return err
	}
	writeResourceLines(cmd.OutOrStdout(), rs, counts)
	return nil
}

// resolveResourceArgs accepts either one URL to infer from, or an explicit
// type and id. The URL form exists because a resource id like
// "C069KSM8T9N:1787257539.775119" is not something anyone derives by hand —
// which is exactly why `worktree add` used to accept Slack URLs.
func resolveResourceArgs(args []string) (resType, id, url string, err error) {
	if len(args) == 2 {
		url := resURL
		if url == "" && args[0] == "jira" {
			// Without a URL the web UI has nothing to open or copy.
			url = jira.ConfiguredIssueURL(args[1])
		}
		return args[0], args[1], url, nil
	}
	t, i, ok := resourceurl.Infer(args[0])
	if !ok {
		return "", "", "", fmt.Errorf(
			"unrecognized resource URL: %s\n  Pass an explicit type and id instead: worktree resources add <type> <id>",
			args[0])
	}
	return t, i, args[0], nil
}

func runResourcesAdd(cmd *cobra.Command, args []string) error {
	resType, id, url, err := resolveResourceArgs(args)
	if err != nil {
		return err
	}
	wt, err := resourceWorktreePath()
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	return resources.Add(conn, wt, resources.Resource{
		Type: resType, ID: id, URL: url, Related: resRelated,
	})
}

func runResourcesUnwatch(cmd *cobra.Command, args []string) error {
	wt, err := resourceWorktreePath()
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	return resources.Unwatch(conn, wt, args[0], args[1])
}

func runResourcesSetName(cmd *cobra.Command, args []string) error {
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	return resources.SetMetaAt(conn, args[0], args[1], resName, resDescription, resUpdatedAt)
}

func runResourcesMarkRead(cmd *cobra.Command, args []string) error {
	bulk := resMarkAll || resMarkWorktree != ""
	switch {
	case resMarkAll && resMarkWorktree != "":
		return fmt.Errorf("--all and --worktree are mutually exclusive")
	case bulk && len(args) > 0:
		return fmt.Errorf("--all and --worktree take no resource argument")
	case bulk && resThrough != "":
		return fmt.Errorf("--through applies to a single resource, not --all or --worktree")
	case !bulk && len(args) != 2:
		return fmt.Errorf("give <type> <id>, or --worktree <path>, or --all")
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	if bulk {
		return markManyRead(conn, cmd.OutOrStdout())
	}
	return markResourceRead(conn, cmd.OutOrStdout(), args[0], args[1], resThrough)
}

// unreadItem is the part of a resource DTO bulk mark-read needs.
type unreadItem struct {
	typ, id                string
	unreadCount, taskCount int
	throughTS              string
}

// markManyRead is `resources mark-read --worktree/--all`. Each resource is
// cleared through its own UnreadThroughTS (the newest of its own unread
// events), so nothing newer than the snapshot is swallowed. Slack threads
// are only counted: their read state is Slack's and the CLI never writes it.
// Unread task events are left alone; they clear through each task's cursor.
func markManyRead(conn *sql.DB, out io.Writer) error {
	srv, err := headlessServer(conn)
	if err != nil {
		return err
	}
	var items []unreadItem
	if resMarkAll {
		rs, err := srv.AllResources()
		if err != nil {
			return err
		}
		for _, r := range rs {
			items = append(items, unreadItem{r.Type, r.ID, r.UnreadCount, r.TaskUnreadCount, r.UnreadThroughTS})
		}
	} else {
		path, err := resolveWorktreeFlag(conn, resMarkWorktree)
		if err != nil {
			return err
		}
		rs, err := srv.WorktreeResources(path)
		if err != nil {
			return err
		}
		for _, r := range rs {
			items = append(items, unreadItem{r.Type, r.ID, r.UnreadCount, r.TaskUnreadCount, r.UnreadThroughTS})
		}
	}
	var marked, skipped, remaining int
	for _, it := range items {
		if it.typ == "slack" {
			if it.unreadCount > 0 {
				skipped++
			}
			continue
		}
		remaining += it.taskCount
		if it.throughTS == "" {
			continue // nothing of its own unread
		}
		if err := unread.MarkRead(conn, it.typ, it.id, it.throughTS); err != nil {
			return fmt.Errorf("mark %s:%s read: %w", it.typ, it.id, err)
		}
		marked++
	}
	if resMarkJSON {
		return printJSON(out, map[string]any{"marked": marked, "skipped_slack": skipped, "task_events_remaining": remaining})
	}
	noun := "resources"
	if marked == 1 {
		noun = "resource"
	}
	fmt.Fprintf(out, "marked %d %s read\n", marked, noun)
	if skipped > 0 {
		fmt.Fprintf(out, "skipped %d Slack thread(s): their read state is Slack's\n", skipped)
	}
	if remaining > 0 {
		fmt.Fprintf(out, "%d unread task event(s) remain: they clear through each task's own cursor\n", remaining)
	}
	return nil
}

// markResourceRead moves a resource's read cursor, defaulting `through` to the
// resource's newest event.
//
// Unlike the web UI — where the client sends the newest timestamp it actually
// RENDERED, so later arrivals survive the mark — the CLI has no rendered view
// to be stale against, so "everything I could have seen" is the honest default.
func markResourceRead(conn *sql.DB, out io.Writer, resType, id, through string) error {
	if resType == "slack" {
		return fmt.Errorf(
			"%w; clear it from the thread view in `worktree ui`", unread.ErrSlackNotSupported)
	}
	if through == "" {
		// The bookkeeping types excluded here are exactly the ones the
		// timelines never render (internal/webui/timeline.go, and the watcher
		// library's EventsForSubscriberSince) and that unread.Counts
		// therefore never counts. Marking read "through" a watch_started or
		// watcher_error the UI never showed would make the CLI and the UI
		// disagree about what the count means.
		if err := conn.QueryRow(`
			SELECT COALESCE(MAX(e.ts), '')
			  FROM watcher_events e
			  JOIN watcher_event_resources er ON er.event_id = e.id
			 WHERE er.resource_type = ? AND er.resource_id = ?
			   AND e.type NOT IN ('watch_started','watcher_error')`,
			resType, id).Scan(&through); err != nil {
			return err
		}
		if through == "" {
			// No events at all: nothing to mark, and MarkRead would reject an
			// empty timestamp. Not an error — the user asked for a state that
			// already holds.
			fmt.Fprintf(out, "no events for %s:%s\n", resType, id)
			return nil
		}
	}
	if err := unread.MarkRead(conn, resType, id, through); err != nil {
		return err
	}
	fmt.Fprintf(out, "marked %s:%s read through %s\n", resType, id, through)
	return nil
}

func runResourcesRemove(cmd *cobra.Command, args []string) error {
	wt, err := resourceWorktreePath()
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	return resources.Remove(conn, wt, args[0], args[1])
}
