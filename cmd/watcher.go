package cmd

import (
	"fmt"
	"log"
	"os"

	watcherdb "github.com/mturley/watcher/db"
	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	wtjira "github.com/mturley/worktree/internal/jira"

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
	// A service whose watcher is off (worktree's config.yaml) is never polled.
	wtcfg, _ := config.Load()
	off := func(svc, name string) bool {
		if wtcfg.Watchers.Enabled(svc) {
			return false
		}
		fmt.Fprintf(cmd.ErrOrStderr(), "%s watcher is disabled; skipping\n", name)
		return true
	}
	polledAny := false
	configuredAny := false

	if (which == "pr" || which == "all") && !off(config.ServiceGitHub, "GitHub") {
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
	if (which == "jira" || which == "all") && !off(config.ServiceJira, "Jira") {
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
					CustomFields: wtjira.ConfiguredCustomFields(jc.CustomFields),
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
