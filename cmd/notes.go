package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/notes"
	"github.com/spf13/cobra"
)

var (
	notesWorktree string
	notesJSON     bool
)

var notesCmd = &cobra.Command{
	Use:     "notes",
	Short:   "Show or set a worktree's notes",
	GroupID: "worktree",
}

var notesShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Print a worktree's notes",
	Long: "Print a worktree's free-text notes, read from the database.\n\n" +
		"--worktree defaults to the current worktree.",
	Args: cobra.NoArgs,
	RunE: runNotesShow,
}

var notesSetCmd = &cobra.Command{
	Use:   "set <text|->",
	Short: "Replace a worktree's notes",
	Long: "Replace a worktree's notes with <text>; \"-\" reads the text from stdin and an\n" +
		"empty string clears the notes. The \"sync to cmux\" and \"show on home\" settings\n" +
		"are kept.\n\n" +
		"This only writes the database. It never talks to cmux: a worktree with cmux\n" +
		"sync on has its workspace description updated by the web UI on its next save.\n\n" +
		"--worktree defaults to the current worktree.",
	Example: "  worktree notes set \"waiting on review\"\n" +
		"  echo \"multi-line\" | worktree notes set - --worktree .",
	Args: cobra.ExactArgs(1),
	RunE: runNotesSet,
}

func init() {
	notesCmd.PersistentFlags().StringVar(&notesWorktree, "worktree", "", `the worktree ("." or a path; default: the current one)`)
	notesShowCmd.Flags().BoolVar(&notesJSON, "json", false, `print {"schema_version": 1, "notes": {"text", "sync_cmux", "show_on_home"}}`)
	notesCmd.AddCommand(notesShowCmd, notesSetCmd)
	rootCmd.AddCommand(notesCmd)
}

func runNotesShow(cmd *cobra.Command, args []string) error {
	conn, err := wdb.OpenRead()
	if err != nil {
		return err
	}
	defer conn.Close()
	path, err := perWorktreePath(conn, notesWorktree)
	if err != nil {
		return err
	}
	n, err := notes.Get(conn, path)
	if err != nil {
		return err
	}
	if notesJSON {
		return printJSON(cmd.OutOrStdout(), map[string]any{"notes": map[string]any{
			"text": n.Text, "sync_cmux": n.SyncCmux, "show_on_home": n.ShowOnHome,
		}})
	}
	if n.Text != "" {
		fmt.Fprintln(cmd.OutOrStdout(), n.Text)
	}
	return nil
}

func runNotesSet(cmd *cobra.Command, args []string) error {
	text := args[0]
	if text == "-" {
		b, err := io.ReadAll(cmd.InOrStdin())
		if err != nil {
			return err
		}
		// The newline `echo` or a heredoc ends with is not part of the note.
		text = strings.TrimSuffix(strings.TrimSuffix(string(b), "\n"), "\r")
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	path, err := perWorktreePath(conn, notesWorktree)
	if err != nil {
		return err
	}
	prev, err := notes.Get(conn, path)
	if err != nil {
		return err
	}
	if _, err := notes.Set(conn, path, text, prev.SyncCmux, prev.ShowOnHome); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Notes saved.")
	return nil
}
