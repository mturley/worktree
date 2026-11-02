package cmd

import (
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resourceurl"
	"github.com/mturley/worktree/internal/webui"
	"github.com/spf13/cobra"
)

var (
	activityWorktree string
	activityResource string
	activitySince    string
	activityUnread   bool
	activitySources  []string
	activityLimit    int
	activityJSON     bool
)

var activityCmd = &cobra.Command{
	Use:   "activity",
	Short: "Show recent activity (the timeline), newest first",
	Long: "Show the activity timeline, newest first, read straight from the database:\n" +
		"no server or login needed. New activity only arrives while `worktree ui` is running and polling.\n\n" +
		"With no --worktree it covers every worktree, even when run inside one.\n" +
		"--worktree . narrows it to the current worktree.\n\n" +
		"Exits 1 when --unread finds nothing.",
	Example: "  worktree activity --since 24h\n" +
		"  worktree activity --unread --source github --json\n" +
		"  worktree activity --worktree . --resource pr:org/repo#12",
	GroupID: "worktree",
	Args:    cobra.NoArgs,
	RunE:    runActivity,
	// Execute prints errors itself; cobra would otherwise add "Error:" and
	// the usage text, including for ErrNothingFound.
	SilenceUsage:  true,
	SilenceErrors: true,
}

func init() {
	f := activityCmd.Flags()
	f.StringVar(&activityWorktree, "worktree", "", `only this worktree's activity ("." for the current one)`)
	f.StringVar(&activityResource, "resource", "", "only this resource: a URL or <type>:<id> (pr, jira, slack, link)")
	f.StringVar(&activitySince, "since", "", "only events since a duration ago (24h, 7d) or an RFC 3339 time")
	f.BoolVar(&activityUnread, "unread", false, "only unread events (exit 1 when there are none)")
	f.StringArrayVar(&activitySources, "source", nil, "only this source: github, jira, slack or tasks (repeatable)")
	f.IntVar(&activityLimit, "limit", 50, "maximum number of events")
	f.BoolVar(&activityJSON, "json", false, `print {"schema_version": 1, "events": [...]}`)
	rootCmd.AddCommand(activityCmd)
}

// resolveWorktreeFlag reads a --worktree value: "." is the current worktree,
// anything else a path. It must be registered, or a mistyped path would read
// as an empty result. The check is the registry, not the filesystem: a
// worktree deleted from disk still passes.
func resolveWorktreeFlag(conn *sql.DB, v string) (string, error) {
	var args []string
	if v != "." {
		args = []string{v}
	}
	path, err := resolveWorktreePath(args)
	if err != nil {
		return "", err
	}
	entries, err := registry.List(conn)
	if err != nil {
		return "", err
	}
	want := wdb.Subscriber(path)
	for _, e := range entries {
		if wdb.Subscriber(e.Path) == want {
			// The registered spelling: a cwd reached through a symlink
			// canonicalizes the same but would miss registry.Get.
			return e.Path, nil
		}
	}
	return "", fmt.Errorf("not a registered worktree: %s", path)
}

// parseSince turns a --since value into an RFC 3339 UTC time: a duration
// ("24h", "7d") means now minus it; an RFC 3339 time passes through.
func parseSince(now time.Time, v string) (string, error) {
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return t.UTC().Format(time.RFC3339), nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		if days, ok := strings.CutSuffix(v, "d"); ok {
			if n, nerr := strconv.Atoi(days); nerr == nil {
				d, err = time.Duration(n)*24*time.Hour, nil
			}
		}
	}
	if err != nil || d < 0 {
		return "", fmt.Errorf("invalid --since %q: want a duration like 24h or 7d, or an RFC 3339 time", v)
	}
	return now.Add(-d).UTC().Format(time.RFC3339), nil
}

// sourceTypes maps --source names to the timeline's resource types.
func sourceTypes(sources []string) ([]string, error) {
	m := map[string]string{"github": "pr", "jira": "jira", "slack": "slack", "tasks": "task"}
	out := make([]string, 0, len(sources))
	for _, s := range sources {
		t, ok := m[s]
		if !ok {
			return nil, fmt.Errorf("unknown --source %q: want github, jira, slack or tasks", s)
		}
		out = append(out, t)
	}
	return out, nil
}

// parseResourceRef reads --resource: a URL, or <type>:<id> split on the first
// ':' (Slack ids contain ':'). Task events cannot be scoped this way.
func parseResourceRef(s string) (typ, id string, err error) {
	if strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") {
		t, i, ok := resourceurl.InferAny(s)
		if !ok {
			return "", "", fmt.Errorf("unrecognised --resource URL %q", s)
		}
		return t, i, nil
	}
	typ, id, found := strings.Cut(s, ":")
	if !found || id == "" {
		return "", "", fmt.Errorf("invalid --resource %q: want a URL or <type>:<id>", s)
	}
	switch typ {
	case "pr", "jira", "slack", "link":
		return typ, id, nil
	case "task":
		return "", "", fmt.Errorf("--resource cannot be a task; use `worktree tasks`")
	}
	return "", "", fmt.Errorf("invalid --resource type %q: want pr, jira, slack or link", typ)
}

func runActivity(cmd *cobra.Command, args []string) error {
	q := webui.TimelineQuery{UnreadOnly: activityUnread, Limit: activityLimit}
	if activityLimit <= 0 {
		return fmt.Errorf("--limit must be positive")
	}
	if activityResource != "" && len(activitySources) > 0 {
		return fmt.Errorf("--resource and --source cannot be combined")
	}
	if activityResource != "" {
		var err error
		if q.ResourceType, q.ResourceID, err = parseResourceRef(activityResource); err != nil {
			return err
		}
	}
	types, err := sourceTypes(activitySources)
	if err != nil {
		return err
	}
	q.ResourceTypes = types
	if activitySince != "" {
		if q.Since, err = parseSince(time.Now(), activitySince); err != nil {
			return err
		}
	}

	conn, err := wdb.OpenRead()
	if err != nil {
		return err
	}
	defer conn.Close()
	if activityWorktree != "" {
		if q.WorktreePath, err = resolveWorktreeFlag(conn, activityWorktree); err != nil {
			return err
		}
	}
	srv, err := headlessServer(conn)
	if err != nil {
		return err
	}
	events, err := srv.Timeline(q)
	if err != nil {
		return err
	}
	if events == nil {
		events = []webui.TimelineEvent{}
	}

	out := cmd.OutOrStdout()
	if activityJSON {
		if err := printJSON(out, map[string]any{"events": events}); err != nil {
			return err
		}
	} else if len(events) == 0 {
		if activityUnread {
			fmt.Fprintln(out, "Nothing unread.")
		} else {
			fmt.Fprintln(out, "No activity.")
		}
	} else {
		for _, e := range events {
			fmt.Fprintln(out, activityLine(e))
		}
	}
	if activityUnread && len(events) == 0 {
		return ErrNothingFound
	}
	return nil
}

// activityLine renders one event: "<local time>  <source>  <resource>  <author>: <title>",
// prefixed with a bullet when unread.
func activityLine(e webui.TimelineEvent) string {
	when := e.TS
	if t, err := time.Parse(time.RFC3339, e.TS); err == nil {
		when = t.Local().Format("2006-01-02 15:04")
	}
	label := e.ResourceTitle
	if label == "" {
		label = e.ResourceID
	}
	text := e.Title
	if e.Author != "" {
		text = e.Author + ": " + text
	}
	prefix := "  "
	if e.Unread {
		prefix = "• "
	}
	return fmt.Sprintf("%s%s  %s  %s  %s", prefix, when, e.Source, label, text)
}
