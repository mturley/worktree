package cmd

import (
	"errors"
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
	slackThreadMessages bool
	slackThreadJSON     bool
)

var slackCmd = &cobra.Command{
	Use:     "slack",
	Short:   "Read Slack threads from the local cache",
	Long:    "Read Slack threads worktree follows (or followed), from the local cache. Nothing here contacts Slack.",
	GroupID: "worktree",
}

var slackThreadCmd = &cobra.Command{
	Use:   "thread <ref>",
	Short: "Show a cached Slack thread: its summary, and with --messages its messages",
	Long: "Show one followed Slack thread, read from the local cache. <ref> is a Slack URL,\n" +
		"slack:<channel>:<ts>, or a name (custom name, title or channel) matching one thread.\n\n" +
		"By default only the summary is printed, so candidates can be shown before the full\n" +
		"messages are read; --messages adds them. Nothing contacts Slack and nothing is\n" +
		"marked read.\n\n" +
		"Exits 1 when no thread matches. A name matching several threads prints the\n" +
		"candidates to stdout, an \"ambiguous\" line to stderr, and exits 2.",
	Example: "  worktree slack thread https://x.slack.com/archives/C1/p1700000000000100\n" +
		"  worktree slack thread \"rollout plan\" --messages --json",
	Args:          cobra.ExactArgs(1),
	RunE:          runSlackThread,
	SilenceUsage:  true,
	SilenceErrors: true,
}

func init() {
	slackThreadCmd.Flags().BoolVar(&slackThreadMessages, "messages", false, "also print the thread's cached messages")
	slackThreadCmd.Flags().BoolVar(&slackThreadJSON, "json", false, `print {"schema_version": 1, "thread", "messages"?}`)
	slackCmd.AddCommand(slackThreadCmd)
	rootCmd.AddCommand(slackCmd)
}

func runSlackThread(cmd *cobra.Command, args []string) error {
	conn, err := wdb.OpenRead()
	if err != nil {
		return err
	}
	defer conn.Close()
	srv, err := headlessServer(conn)
	if err != nil {
		return err
	}
	out := cmd.OutOrStdout()
	id, err := srv.ResolveSlackThread(args[0])
	var amb *webui.AmbiguousThreadError
	switch {
	case errors.As(err, &amb):
		if slackThreadJSON {
			if err := printJSON(out, map[string]any{"ambiguous": true, "candidates": amb.Candidates}); err != nil {
				return err
			}
		} else {
			for _, c := range amb.Candidates {
				fmt.Fprintf(out, "%s  %s  %s\n", c.ID, threadLabel(c), c.URL)
			}
		}
		return printed(err)
	case errors.Is(err, webui.ErrThreadNotFound):
		if !slackThreadJSON {
			fmt.Fprintf(out, "No Slack thread matches %q.\n", args[0])
		}
		return ErrNothingFound
	case err != nil:
		return err
	}
	th, err := srv.SlackThread(id)
	if err != nil {
		return err
	}
	var msgs []webui.SlackMessage
	if slackThreadMessages {
		if msgs, err = srv.SlackThreadMessages(id); err != nil {
			return err
		}
		if msgs == nil {
			msgs = []webui.SlackMessage{}
		}
	}
	if slackThreadJSON {
		obj := map[string]any{"thread": th}
		if slackThreadMessages {
			obj["messages"] = msgs
		}
		return printJSON(out, obj)
	}
	printSlackThreadHuman(out, th, msgs, slackThreadMessages)
	return nil
}

func threadLabel(t webui.SlackThreadSummary) string {
	switch {
	case t.CustomName != "":
		return t.CustomName
	case t.Title != "":
		return t.Title
	case t.ChannelName != "":
		return t.ChannelName
	}
	return t.ID
}

func localTime(rfc string) string {
	if t, err := time.Parse(time.RFC3339, rfc); err == nil {
		return t.Local().Format("2006-01-02 15:04")
	}
	return rfc
}

func printSlackThreadHuman(out io.Writer, t webui.SlackThreadSummary, msgs []webui.SlackMessage, withMessages bool) {
	fmt.Fprintln(out, ui.Bold(threadLabel(t)))
	if t.CustomDescription != "" {
		fmt.Fprintln(out, t.CustomDescription)
	}
	meta := ""
	if t.ChannelName != "" {
		meta = "#" + t.ChannelName + "  "
	}
	fmt.Fprintf(out, "%sstarted by %s, %s  updated %s\n", meta, t.Author, localTime(t.StartedAt), localTime(t.UpdatedAt))
	state := fmt.Sprintf("%d replies", t.ReplyCount)
	if t.Unread {
		state += ", unread"
	}
	if t.Archived {
		state += ", archived"
	}
	fmt.Fprintln(out, state)
	fmt.Fprintln(out, ui.Dim(t.URL))
	if len(t.Worktrees) > 0 {
		fmt.Fprintf(out, "Worktrees: %s\n", strings.Join(t.Worktrees, ", "))
	}
	if len(t.LastFollowedBy) > 0 {
		fmt.Fprintf(out, "Last followed by: %s\n", strings.Join(t.LastFollowedBy, ", "))
	}
	if t.FirstMessage != "" {
		fmt.Fprintf(out, "\n%s\n", t.FirstMessage)
	}
	if !t.Complete {
		fmt.Fprintf(out, "\nOnly %d of %d replies are cached.\n", t.RepliesCached, t.ReplyCount)
	}
	if !withMessages {
		return
	}
	for _, m := range msgs {
		fmt.Fprintf(out, "\n%s · %s", ui.Bold(m.Author), localTime(m.SentAt))
		if m.Synthesized {
			fmt.Fprint(out, " "+ui.Dim("(from the follow event)"))
		}
		fmt.Fprintf(out, "\n%s\n", m.Text)
	}
}
