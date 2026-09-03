package cmd

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resourceurl"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/unread"
	"github.com/spf13/cobra"
)

type resourceJSON struct {
	Type              string `json:"type"`
	ID                string `json:"id"`
	URL               string `json:"url"`
	Primary           bool   `json:"primary"`
	CustomName        string `json:"custom_name,omitempty"`
	CustomDescription string `json:"custom_description,omitempty"`
	UpdatedAt         string `json:"updated_at,omitempty"`
	UnreadCount       int    `json:"unread_count,omitempty"`
}

func resourcesJSON(rs []resources.Resource, counts map[string]int) ([]byte, error) {
	out := make([]resourceJSON, 0, len(rs)) // ensures [] not null when empty
	for _, r := range rs {
		out = append(out, resourceJSON{
			Type: r.Type, ID: r.ID, URL: r.URL, Primary: !r.Related,
			CustomName: r.CustomName, CustomDescription: r.CustomDescription,
			UpdatedAt: r.UpdatedAt,
			// A nil map reads as zero, which is what "no cursor" means.
			UnreadCount: counts[unread.Key(r.Type, r.ID)],
		})
	}
	return json.Marshal(out)
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
	resWorktree    string
	resJSON        bool
	resURL         string
	resRelated     bool
	resName        string
	resDescription string
	resUpdatedAt   string
	resThrough     string
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
		"for every worktree tracking it.",
	Args: cobra.ExactArgs(2),
	RunE: runResourcesMarkRead,
}

func init() {
	resourcesListCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesListCmd.Flags().BoolVar(&resJSON, "json", false, "machine-readable JSON output")
	resourcesAddCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesAddCmd.Flags().StringVar(&resURL, "url", "", "resource URL")
	resourcesAddCmd.Flags().BoolVar(&resRelated, "related", false, "mark as related (not primary)")
	resourcesUnwatchCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesRemoveCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesSetNameCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesSetNameCmd.Flags().StringVar(&resName, "name", "", "custom name (empty clears it)")
	resourcesSetNameCmd.Flags().StringVar(&resDescription, "description", "", "custom description")
	resourcesSetNameCmd.Flags().StringVar(&resUpdatedAt, "updated-at", "", "explicit RFC3339 timestamp for replication (default: now)")
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
	wt, err := resourceWorktreePath()
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	rs, err := resources.Load(conn, wt)
	if err != nil {
		return err
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		return err
	}
	if resJSON {
		b, err := resourcesJSON(rs, counts)
		if err != nil {
			return err
		}
		fmt.Fprintln(cmd.OutOrStdout(), string(b))
		return nil
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
		return args[0], args[1], resURL, nil
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
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	return markResourceRead(conn, cmd.OutOrStdout(), args[0], args[1], resThrough)
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
		if err := conn.QueryRow(`
			SELECT COALESCE(MAX(e.ts), '')
			  FROM watcher_events e
			  JOIN watcher_event_resources er ON er.event_id = e.id
			 WHERE er.resource_type = ? AND er.resource_id = ?`,
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
