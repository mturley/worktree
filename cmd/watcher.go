package cmd

import (
	"fmt"
	"log"
	"os"

	watcherdb "github.com/mturley/watcher/db"
	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	wdb "github.com/mturley/worktree/internal/db"

	wconfig "github.com/mturley/watcher/config"

	"github.com/spf13/cobra"
)

var watcherCmd = &cobra.Command{
	Use:     "watcher",
	Short:   "Watcher (resource polling) commands",
	GroupID: "worktree",
}

var watcherRunCmd = &cobra.Command{
	Use:   "run [pr|jira|all]",
	Short: "Poll tracked resources once, writing timeline events to the DB",
	Args:  cobra.MaximumNArgs(1),
	RunE:  runWatcherRun,
}

func init() {
	watcherCmd.AddCommand(watcherRunCmd)
	rootCmd.AddCommand(watcherCmd)
}

func runWatcherRun(cmd *cobra.Command, args []string) error {
	which := "all"
	if len(args) == 1 {
		which = args[0]
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()

	logger := log.New(os.Stderr, "watcher: ", 0)

	cfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		return fmt.Errorf("loading ~/.config/watcher/auth.yaml: %w (run watcher auth setup)", err)
	}

	notConfigured := fmt.Errorf("no credentials configured in ~/.config/watcher/auth.yaml (run watcher auth setup)")
	polledAny := false
	configuredAny := false

	if which == "pr" || which == "all" {
		prs, err := watcherdb.ActiveResources(conn, "pr")
		if err != nil {
			return err
		}
		if len(prs) > 0 {
			polledAny = true
			ghCreds, err := cfg.GitHub()
			if err != nil {
				fmt.Fprintln(cmd.ErrOrStderr(), "GitHub not configured in ~/.config/watcher/auth.yaml (run watcher auth setup)")
			} else {
				configuredAny = true
				if err := wgithub.Poll(conn, ghCreds.Token, prs, logger); err != nil {
					logger.Printf("github poll: %v", err)
				}
			}
		}
	}
	if which == "jira" || which == "all" {
		issues, err := watcherdb.ActiveResources(conn, "jira")
		if err != nil {
			return err
		}
		if len(issues) > 0 {
			polledAny = true
			jc, err := cfg.Jira()
			if err != nil {
				fmt.Fprintln(cmd.ErrOrStderr(), "Jira not configured in ~/.config/watcher/auth.yaml (run watcher auth setup)")
			} else {
				configuredAny = true
				auth := wjira.JiraAuth{
					URL:          jc.Host,
					Email:        jc.Email,
					Token:        jc.Token,
					CustomFields: jc.CustomFields,
					BotUsernames: nil,
				}
				if err := wjira.Poll(conn, auth, issues, logger); err != nil {
					logger.Printf("jira poll: %v", err)
				}
			}
		}
	}

	if polledAny && !configuredAny {
		return notConfigured
	}

	fmt.Fprintln(cmd.OutOrStdout(), "poll complete")
	return nil
}
