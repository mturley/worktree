package cmd

import (
	"fmt"
	"strings"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/ui"
	"github.com/mturley/worktree/internal/webui"
	"github.com/spf13/cobra"
)

var jiraCmd = &cobra.Command{
	Use:     "jira [path]",
	Short:   "Show Jira issues associated with a worktree (cached state; never contacts Jira)",
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

var (
	jiraRelated bool
	jiraJSON    bool
)

func init() {
	jiraCmd.Flags().BoolVar(&jiraJSON, "json", false, "machine-readable JSON output")
	jiraAddCmd.Flags().BoolVar(&jiraRelated, "related", false, "Add as a related (context) issue instead of primary")
	jiraCmd.AddCommand(jiraAddCmd)
	jiraCmd.AddCommand(jiraRemoveCmd)
	rootCmd.AddCommand(jiraCmd)
}

func runJira(cmd *cobra.Command, args []string) error {
	w := cmd.OutOrStdout()
	wtPath, err := resolveWorktreePath(args)
	if err != nil {
		return err
	}

	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	srv, err := headlessServer(conn)
	if err != nil {
		return err
	}

	// Cached watcher state only: this never contacts Jira.
	dtos, err := srv.WorktreeResources(wtPath)
	if err != nil {
		return err
	}
	var issues []webui.ResourceDTO
	for _, d := range dtos {
		if d.Type == "jira" {
			issues = append(issues, d)
		}
	}

	if jiraJSON {
		meta := metaTimes(conn, wtPath)
		items := make([]map[string]any, 0, len(issues))
		for _, d := range issues {
			item, err := resourceItem(d, meta[[2]string{d.Type, d.ID}])
			if err != nil {
				return err
			}
			items = append(items, item)
		}
		return printJSON(cmd.OutOrStdout(), map[string]any{"issues": items})
	}

	if len(issues) == 0 {
		fmt.Fprintln(w, "No Jira issues associated with this worktree.")
		fmt.Fprintln(w, "Use 'worktree jira add <key>' to associate one.")
		return nil
	}

	for _, r := range issues {
		prefix := " "
		if !r.Primary {
			prefix = "~"
		}
		if r.Title == "" && r.Status == "" && r.Priority == "" {
			// Never polled: all there is to show is the key and link.
			fmt.Fprintf(w, "%s %s %s\n", ui.Dim(prefix), ui.Cyan(r.ID), ui.Dim(r.URL))
			continue
		}
		fmt.Fprintf(w, "%s %s", ui.Dim(prefix), ui.Cyan(r.ID))
		for _, f := range []string{r.Status, r.Priority, r.Title} {
			if f != "" {
				fmt.Fprintf(w, "  %s", f)
			}
		}
		fmt.Fprintln(w)
	}
	return nil
}

func runJiraAdd(cmd *cobra.Command, args []string) error {
	key := strings.ToUpper(args[0])
	wtPath, err := resolveWorktreePath(nil)
	if err != nil {
		return err
	}

	url := jira.ConfiguredIssueURL(key)

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
