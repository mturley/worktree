package cmd

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/mturley/watcher/slack"
	"github.com/spf13/cobra"

	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/linked"
	"github.com/mturley/worktree/internal/setup"
	"github.com/mturley/worktree/internal/slackcreds"
	"github.com/mturley/worktree/internal/webui"
)

var (
	linkedResolveLinks bool
	linkedJSON         bool
)

var linkedCmd = &cobra.Command{
	Use:   "linked <url|type:id>",
	Short: "Show what a PR, Jira issue or Slack thread links to (contacts the service)",
	Long: "Show the resources linked from a PR, Jira issue or Slack thread: the Linked\n" +
		"Resources tab. This contacts the resource's service (cached for two minutes)\n" +
		"and refuses, exit 2, while that service's watcher is off. Services whose\n" +
		"watcher is off, or that have no credentials, are skipped when enriching the\n" +
		"result. --resolve-links also fetches the titles of plain web links.",
	Example: "  worktree linked https://github.com/org/repo/pull/12\n" +
		"  worktree linked jira:PROJ-123 --json",
	GroupID:       "worktree",
	Args:          cobra.ExactArgs(1),
	RunE:          runLinked,
	SilenceUsage:  true,
	SilenceErrors: true,
}

func init() {
	f := linkedCmd.Flags()
	f.BoolVar(&linkedResolveLinks, "resolve-links", false, "fetch the titles of plain web links")
	f.BoolVar(&linkedJSON, "json", false, `print {"schema_version": 1, "linked": {...}}`)
	rootCmd.AddCommand(linkedCmd)
}

// buildLinkedServer is buildServer plus a Slack client, for `linked` only:
// no other command reads Slack credentials. The client is gated on the Slack
// watcher, and left nil when the watcher is off or there are no credentials.
func buildLinkedServer(conn *sql.DB) (*webui.Server, error) {
	srv, err := buildServer(conn)
	if err != nil {
		return nil, err
	}
	if srv.WatcherEnabled(config.ServiceSlack) {
		if token, cookie, domain, err := slackcreds.Load(); err == nil {
			srv.SlackClient = webui.GateSlack(slack.New(token, cookie),
				func() bool { return srv.WatcherEnabled(config.ServiceSlack) })
			srv.SlackDomain = domain
		}
	}
	return srv, nil
}

func runLinked(cmd *cobra.Command, args []string) error {
	typ, id, err := parseResourceRef(args[0])
	if err != nil {
		return fmt.Errorf("invalid resource %q: want a URL or <type>:<id> (pr, jira or slack)", args[0])
	}
	conn, err := wdb.OpenRead()
	if err != nil {
		return err
	}
	defer conn.Close()
	srv, err := buildLinkedServer(conn)
	if err != nil {
		return err
	}
	res, err := srv.Linked(cmd.Context(), typ, id, linkedResolveLinks)
	var off webui.ErrWatcherOff
	switch {
	case errors.As(err, &off):
		return errors.New(setup.WatcherOffMessage(off.Service))
	case errors.Is(err, linked.ErrNotConfigured):
		return fmt.Errorf("no credentials are configured for %s; add them in Settings (worktree ui) or run `worktree setup`", typ)
	case err != nil:
		return err
	}
	out := cmd.OutOrStdout()
	if linkedJSON {
		return printJSON(out, map[string]any{"linked": res})
	}
	if r, ok := res.(*linked.Result); ok {
		printLinked(out, r)
	}
	return nil
}

func printLinked(w io.Writer, r *linked.Result) {
	if r.Count == 0 {
		fmt.Fprintln(w, "No linked resources.")
	}
	item := func(indent string, it linked.Item) {
		line := it.Type + ":" + it.ID
		if it.Title != "" {
			line += "  " + it.Title
		}
		if it.Status != "" {
			line += "  [" + it.Status + "]"
		} else if it.State != "" {
			line += "  [" + strings.ToLower(it.State) + "]"
		}
		fmt.Fprintf(w, "%s%s\n", indent, line)
	}
	var tree func(indent string, n *linked.TreeNode)
	tree = func(indent string, n *linked.TreeNode) {
		item(indent, n.Item)
		for _, c := range n.Children {
			tree(indent+"  ", c)
		}
	}
	for _, s := range r.Sections {
		if len(s.Items) == 0 && len(s.Groups) == 0 && len(s.Tree) == 0 && s.Error == "" {
			continue
		}
		fmt.Fprintf(w, "%s\n", s.Title)
		if s.Error != "" {
			fmt.Fprintf(w, "  (unavailable: %s)\n", s.Error)
		}
		for _, it := range s.Items {
			item("  ", it)
		}
		for _, g := range s.Groups {
			fmt.Fprintf(w, "  %s\n", g.Label)
			for _, it := range g.Items {
				item("    ", it)
			}
		}
		for _, n := range s.Tree {
			tree("  ", n)
		}
	}
}
