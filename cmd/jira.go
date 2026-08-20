package cmd

import (
	"fmt"
	"strings"

	wconfig "github.com/mturley/watcher/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

var jiraCmd = &cobra.Command{
	Use:     "jira [path]",
	Short:   "Show Jira issues associated with a worktree",
	GroupID: "integration",
	RunE:    runJira,
}

var jiraAddCmd = &cobra.Command{
	Use:   "add <key>",
	Short: "Associate a Jira issue with the current worktree",
	Args:  cobra.ExactArgs(1),
	RunE:  runJiraAdd,
}

var jiraRemoveCmd = &cobra.Command{
	Use:   "remove <key>",
	Short: "Remove a Jira issue association",
	Args:  cobra.ExactArgs(1),
	RunE:  runJiraRemove,
}

var jiraRelated bool

func init() {
	jiraAddCmd.Flags().BoolVar(&jiraRelated, "related", false, "Add as a related (context) issue instead of primary")
	jiraCmd.AddCommand(jiraAddCmd)
	jiraCmd.AddCommand(jiraRemoveCmd)
	rootCmd.AddCommand(jiraCmd)
}

func runJira(cmd *cobra.Command, args []string) error {
	wtPath, err := resolveWorktreePath(args)
	if err != nil {
		return err
	}

	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()

	res, _ := resources.Load(conn, wtPath)
	jiraResources := resources.OfType(res, "jira")

	if len(jiraResources) == 0 {
		fmt.Println("No Jira issues associated with this worktree.")
		fmt.Println("Use 'worktree jira add <key>' to associate one.")
		return nil
	}

	var client *jira.Client
	var clientErr error
	wcfg, wcfgErr := wconfig.Load(wconfig.DefaultPath())
	if wcfgErr != nil {
		clientErr = wcfgErr
	} else if creds, err := wcfg.Jira(); err != nil {
		clientErr = err
	} else {
		client, clientErr = jira.NewClient(creds.Host, creds.Email, creds.Token)
	}

	for _, r := range jiraResources {
		prefix := " "
		if r.Related {
			prefix = "~"
		}

		if clientErr == nil {
			issue, err := client.FetchIssue(r.ID)
			if err == nil {
				typeIcon := issueTypeIcon(issue.Type)
				fmt.Printf("%s %s %s — %s\n", ui.Dim(prefix), typeIcon, ui.Cyan(issue.Key), issue.Summary)
				fmt.Printf("    Type: %s · Priority: %s · Status: %s", issue.Type, issue.Priority, issue.Status)
				if issue.Assignee != "" {
					fmt.Printf(" · Assignee: %s", issue.Assignee)
				}
				fmt.Println()
				continue
			}
		}

		fmt.Printf("%s %s %s\n", ui.Dim(prefix), ui.Cyan(r.ID), ui.Dim(r.URL))
	}
	return nil
}

func runJiraAdd(cmd *cobra.Command, args []string) error {
	key := strings.ToUpper(args[0])
	wtPath, err := resolveWorktreePath(nil)
	if err != nil {
		return err
	}

	host := ""
	if wcfg, err := wconfig.Load(wconfig.DefaultPath()); err == nil {
		if creds, err := wcfg.Jira(); err == nil {
			host = creds.Host
		}
	}

	url := jira.IssueURL(host, key)
	if host == "" {
		url = key
	}

	r := resources.Resource{
		Type:    "jira",
		ID:      key,
		URL:     url,
		Related: jiraRelated,
	}

	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()

	if err := resources.Add(conn, wtPath, r); err != nil {
		return err
	}

	role := "primary"
	if jiraRelated {
		role = "related"
	}
	fmt.Printf("%s Added %s as %s Jira issue\n", ui.Green("✓"), ui.Cyan(key), role)
	return nil
}

func runJiraRemove(cmd *cobra.Command, args []string) error {
	key := strings.ToUpper(args[0])
	wtPath, err := resolveWorktreePath(nil)
	if err != nil {
		return err
	}

	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()

	if err := resources.Remove(conn, wtPath, "jira", key); err != nil {
		return err
	}
	fmt.Printf("%s Removed %s\n", ui.Green("✓"), key)
	return nil
}

func issueTypeIcon(t string) string {
	switch strings.ToLower(t) {
	case "bug":
		return "Bug"
	case "story":
		return "Story"
	case "task":
		return "Task"
	case "epic":
		return "Epic"
	case "sub-task":
		return "Sub-task"
	default:
		return t
	}
}
