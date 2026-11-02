package cmd

import (
	"fmt"
	"sort"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/webui"
	"github.com/spf13/cobra"
)

var (
	unreadJSON bool
	unreadBy   string
)

var unreadCmd = &cobra.Command{
	Use:   "unread",
	Short: "Show whether any worktree has unread activity",
	Long: "Show whether any worktree has unread activity, and how many unread events in all:\n" +
		"the web UI's blinking tab, from the database, with no server or login needed.\n" +
		"New activity only arrives while `worktree ui` is running and polling.\n\n" +
		"The macOS menu bar app runs `worktree unread --json` as a backstop to the page.\n\n" +
		"--by worktree|resource adds the count per worktree path or per type:id. A resource\n" +
		"followed by two worktrees counts in both under --by worktree.\n\n" +
		"Always exits 0, including when nothing is unread.",
	GroupID: "worktree",
	Args:    cobra.NoArgs,
	RunE:    runUnread,
}

func init() {
	unreadCmd.Flags().BoolVar(&unreadJSON, "json", false, `print {"schema_version": 1, "unread": bool, "count": n}, plus "by" with --by`)
	unreadCmd.Flags().StringVar(&unreadBy, "by", "", `break the count down: "worktree" (by path) or "resource" (by type:id); only non-zero entries`)
	rootCmd.AddCommand(unreadCmd)
}

func runUnread(cmd *cobra.Command, args []string) error {
	if unreadBy != "" && unreadBy != "worktree" && unreadBy != "resource" {
		return fmt.Errorf("unknown --by %q (want worktree or resource)", unreadBy)
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()

	srv := &webui.Server{DB: conn}
	sum, err := srv.AppUnread()
	if err != nil {
		return err
	}
	var by map[string]int
	if unreadBy != "" {
		if by, err = srv.UnreadBy(unreadBy); err != nil {
			return err
		}
	}
	if unreadJSON {
		fields := map[string]any{"unread": sum.Unread, "count": sum.Count}
		if by != nil {
			fields["by"] = by
		}
		return printJSON(cmd.OutOrStdout(), fields)
	}
	switch {
	case !sum.Unread:
		fmt.Println("Nothing unread.")
	case sum.Count == 1:
		fmt.Println("1 unread event.")
	default:
		fmt.Printf("%d unread events.\n", sum.Count)
	}
	keys := make([]string, 0, len(by))
	for k := range by {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Printf("  %s: %d\n", k, by[k])
	}
	return nil
}
