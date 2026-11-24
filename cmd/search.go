package cmd

import (
	"fmt"
	"io"
	"strings"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/ui"
	"github.com/mturley/worktree/internal/webui"
	"github.com/spf13/cobra"
)

var (
	searchWorktree   string
	searchSources    []string
	searchTypes      []string
	searchSince      string
	searchUnread     bool
	searchArchived   bool
	searchHumansOnly bool
	searchLimit      int
	searchJSON       bool
)

var searchCmd = &cobra.Command{
	Use:   "search <terms…>",
	Short: "Search worktrees, resources, tasks and activity, as the web UI's search bar does",
	Long: "Search worktrees, followed resources, tasks and activity events for the given terms,\n" +
		"read straight from the database: no server or login needed. Every term must appear\n" +
		"(in some field) for a hit; the terms are the remaining arguments joined by spaces.\n\n" +
		"Results are grouped: Worktrees, Resources, Tasks and Activity. Each hit shows why it\n" +
		"matched. With --worktree the search is scoped to that worktree and the Worktrees and\n" +
		"Tasks groups are left out. --archived searches resources no worktree follows any more.\n\n" +
		"Exits 1 when nothing matched, 2 on an error (including an empty query).",
	Example: "  worktree search dashboard login\n" +
		"  worktree search --source github --since 7d flaky\n" +
		"  worktree search --worktree . --unread review --json",
	GroupID: "worktree",
	Args:    cobra.MinimumNArgs(1),
	RunE:    runSearch,
	// Execute prints errors itself.
	SilenceUsage:  true,
	SilenceErrors: true,
}

func init() {
	f := searchCmd.Flags()
	f.StringVar(&searchWorktree, "worktree", "", `scope to this worktree ("." for the current one)`)
	f.StringArrayVar(&searchSources, "source", nil, "only this source: github, jira, slack, tasks or links (repeatable)")
	f.StringArrayVar(&searchTypes, "type", nil, "only activity events of this type; a trailing * matches a prefix (repeatable)")
	f.StringVar(&searchSince, "since", "", "only activity since a duration ago (24h, 7d) or an RFC 3339 time")
	f.BoolVar(&searchUnread, "unread", false, "only unread resources and activity")
	f.BoolVar(&searchArchived, "archived", false, "search resources no worktree follows (not with --worktree)")
	f.BoolVar(&searchHumansOnly, "humans-only", false, "leave out bots' and CI activity")
	f.IntVar(&searchLimit, "limit", 20, "maximum number of activity events")
	f.BoolVar(&searchJSON, "json", false, `print {"schema_version": 1, "query", "terms", "scope", "worktrees", "resources", "tasks", "events"}`)
	rootCmd.AddCommand(searchCmd)
}

func runSearch(cmd *cobra.Command, args []string) error {
	if searchLimit <= 0 {
		return fmt.Errorf("--limit must be positive")
	}
	if searchArchived && searchWorktree != "" {
		return fmt.Errorf("--archived and --worktree cannot be combined")
	}
	query := strings.Join(args, " ")
	if strings.TrimSpace(query) == "" {
		return webui.ErrEmptyQuery
	}
	types, err := sourceTypes(searchSources)
	if err != nil {
		return err
	}
	q := webui.SearchQuery{
		Query:      query,
		Sources:    types,
		UnreadOnly: searchUnread,
		Archived:   searchArchived,
		HumansOnly: searchHumansOnly,
		EventTypes: searchTypes,
		Limits:     webui.SearchLimits{Events: searchLimit},
	}
	if searchSince != "" {
		if q.Since, err = parseSince(time.Now(), searchSince); err != nil {
			return err
		}
	}
	conn, err := wdb.OpenRead()
	if err != nil {
		return err
	}
	defer conn.Close()
	if searchWorktree != "" {
		if q.WorktreePath, err = resolveWorktreeFlag(conn, searchWorktree); err != nil {
			return err
		}
	}
	srv, err := headlessServer(conn)
	if err != nil {
		return err
	}
	res, err := srv.Search(q)
	if err != nil {
		return err
	}
	scoped := q.WorktreePath != ""
	empty := len(res.Worktrees)+len(res.Resources)+len(res.Tasks)+len(res.Events) == 0

	out := cmd.OutOrStdout()
	if searchJSON {
		scope := "all"
		if scoped {
			scope = q.WorktreePath
		}
		if res.Resources == nil {
			res.Resources = []webui.SearchResourceHit{}
		}
		if res.Events == nil {
			res.Events = []webui.SearchEventHit{}
		}
		obj := map[string]any{
			"query":     query,
			"terms":     res.Terms,
			"scope":     scope,
			"resources": res.Resources,
			"events":    res.Events,
		}
		if !scoped {
			if res.Worktrees == nil {
				res.Worktrees = []webui.SearchWorktreeHit{}
			}
			if res.Tasks == nil {
				res.Tasks = []webui.SearchTaskHit{}
			}
			obj["worktrees"] = res.Worktrees
			obj["tasks"] = res.Tasks
		}
		if err := printJSON(out, obj); err != nil {
			return err
		}
	} else if empty {
		fmt.Fprintln(out, "No matches.")
	} else {
		printSearchHuman(out, res)
	}
	if empty {
		return ErrNothingFound
	}
	return nil
}

// visibleFields is the Go twin of VISIBLE_FIELDS in ui/src/lib/search.ts:
// fields already shown as the row's label, so they get no "why" (a match
// through a resource still explains itself). Keep the two identical.
var visibleFields = map[string]bool{
	"title": true, "name": true, "key": true, "branch": true, "repo": true, "workspace": true,
}

// matchWhy words a hit's match: "via <key>" for a worktree matched through a
// resource, else "field: snippet". Dimmed, so nothing prints ANSI when piped.
func matchWhy(m *webui.SearchMatch) string {
	if m == nil || (m.ViaKey == "" && visibleFields[m.Field]) {
		return ""
	}
	why := m.Field + ": " + m.Snippet
	if m.ViaKey != "" {
		why = "via " + m.ViaKey
	}
	return "  " + ui.Dim(why)
}

func printSearchHuman(out io.Writer, res webui.SearchResult) {
	first := true
	heading := func(name string, n int) bool {
		if n == 0 {
			return false
		}
		if !first {
			fmt.Fprintln(out)
		}
		first = false
		fmt.Fprintln(out, ui.Bold(name))
		return true
	}
	if heading("Worktrees", len(res.Worktrees)) {
		for _, w := range res.Worktrees {
			fmt.Fprintf(out, "  %s  %s  %s%s\n", w.Repo, w.Branch, ui.ShortPath(w.Path), matchWhy(w.Match))
		}
	}
	if heading("Resources", len(res.Resources)) {
		for _, r := range res.Resources {
			label := r.CustomName
			if label == "" {
				label = r.Title
			}
			if label == "" {
				label = r.ID
			}
			prefix := "  "
			if r.Unread {
				prefix = "• "
			}
			fmt.Fprintf(out, "%s%s:%s  %s%s\n", prefix, r.Type, r.ID, label, matchWhy(r.Match))
		}
	}
	if heading("Tasks", len(res.Tasks)) {
		for _, t := range res.Tasks {
			fmt.Fprintf(out, "  %s  %s  %s%s\n", t.Ref, t.State, t.Title, matchWhy(t.Match))
		}
	}
	if heading("Activity", len(res.Events)) {
		for _, e := range res.Events {
			fmt.Fprintln(out, searchEventLine(e)+matchWhy(e.Match))
		}
	}
}

func searchEventLine(e webui.SearchEventHit) string {
	when := e.TS
	if t, err := time.Parse(time.RFC3339, e.TS); err == nil {
		when = t.Local().Format("2006-01-02 15:04")
	}
	label := e.Resource.CustomName
	if label == "" {
		label = e.Resource.Title
	}
	if label == "" {
		label = e.Resource.ID
	}
	text := e.Title
	if e.Author != "" {
		text = e.Author + ": " + text
	}
	prefix := "  "
	if e.Unread {
		prefix = "• "
	}
	return fmt.Sprintf("%s%s  %s  %s  %s  [%s]", prefix, when, e.Source, label, text, e.ID)
}
