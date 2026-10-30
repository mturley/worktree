package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/webui"
	"github.com/spf13/cobra"
)

var unreadJSON bool

var unreadCmd = &cobra.Command{
	Use:   "unread",
	Short: "Show whether any worktree has unread activity",
	Long: "Show whether any worktree has unread activity, and how many unread events in all:\n" +
		"the web UI's blinking tab, from the database, with no server or login needed.\n" +
		"New activity only arrives while `worktree ui` is running and polling.\n\n" +
		"The macOS menu bar app runs `worktree unread --json` as a backstop to the page.",
	GroupID: "worktree",
	Args:    cobra.NoArgs,
	RunE:    runUnread,
}

func init() {
	unreadCmd.Flags().BoolVar(&unreadJSON, "json", false, `print {"unread": bool, "count": n}`)
	rootCmd.AddCommand(unreadCmd)
}

func runUnread(cmd *cobra.Command, args []string) error {
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()

	sum, err := (&webui.Server{DB: conn}).AppUnread()
	if err != nil {
		return err
	}
	if unreadJSON {
		return json.NewEncoder(os.Stdout).Encode(sum)
	}
	switch {
	case !sum.Unread:
		fmt.Println("Nothing unread.")
	case sum.Count == 1:
		fmt.Println("1 unread event.")
	default:
		fmt.Printf("%d unread events.\n", sum.Count)
	}
	return nil
}
