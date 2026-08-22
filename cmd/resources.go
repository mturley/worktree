package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
	"github.com/spf13/cobra"
)

type resourceJSON struct {
	Type              string `json:"type"`
	ID                string `json:"id"`
	URL               string `json:"url"`
	Primary           bool   `json:"primary"`
	CustomName        string `json:"custom_name,omitempty"`
	CustomDescription string `json:"custom_description,omitempty"`
	UpdatedAt         string `json:"updated_at,omitempty"`
}

func resourcesJSON(rs []resources.Resource) ([]byte, error) {
	out := make([]resourceJSON, 0, len(rs)) // ensures [] not null when empty
	for _, r := range rs {
		out = append(out, resourceJSON{
			Type: r.Type, ID: r.ID, URL: r.URL, Primary: !r.Related,
			CustomName: r.CustomName, CustomDescription: r.CustomDescription,
			UpdatedAt: r.UpdatedAt,
		})
	}
	return json.Marshal(out)
}

var (
	resWorktree    string
	resJSON        bool
	resURL         string
	resRelated     bool
	resName        string
	resDescription string
	resUpdatedAt   string
)

var resourcesCmd = &cobra.Command{
	Use:     "resources",
	Short:   "Manage resources tracked by a worktree",
	GroupID: "worktree",
}

var resourcesListCmd = &cobra.Command{
	Use:   "list",
	Short: "List tracked resources",
	RunE:  runResourcesList,
}

var resourcesAddCmd = &cobra.Command{
	Use:   "add <type> <id>",
	Short: "Track a resource",
	Args:  cobra.ExactArgs(2),
	RunE:  runResourcesAdd,
}

var resourcesUnwatchCmd = &cobra.Command{
	Use:   "unwatch <type> <id>",
	Short: "Soft-unsubscribe from a resource (user tombstone)",
	Args:  cobra.ExactArgs(2),
	RunE:  runResourcesUnwatch,
}

var resourcesRemoveCmd = &cobra.Command{
	Use:   "remove <type> <id>",
	Short: "Hard-remove a resource",
	Args:  cobra.ExactArgs(2),
	RunE:  runResourcesRemove,
}

var resourcesSetNameCmd = &cobra.Command{
	Use:   "set-name <type> <id>",
	Short: "Set a resource's custom name/description",
	Long: "Set a resource's user-supplied custom name (and optional description). " +
		"An empty --name clears the name. --updated-at supplies an explicit " +
		"timestamp for cross-database replication; when omitted the write is " +
		"stamped with the current time.",
	Args: cobra.ExactArgs(2),
	RunE: runResourcesSetName,
}

func init() {
	resourcesListCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesListCmd.Flags().BoolVar(&resJSON, "json", false, "machine-readable JSON output")
	resourcesAddCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesAddCmd.Flags().StringVar(&resURL, "url", "", "resource URL")
	resourcesAddCmd.Flags().BoolVar(&resRelated, "related", false, "mark as related (not primary)")
	resourcesUnwatchCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesRemoveCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesSetNameCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesSetNameCmd.Flags().StringVar(&resName, "name", "", "custom name (empty clears it)")
	resourcesSetNameCmd.Flags().StringVar(&resDescription, "description", "", "custom description")
	resourcesSetNameCmd.Flags().StringVar(&resUpdatedAt, "updated-at", "", "explicit RFC3339 timestamp for replication (default: now)")

	resourcesCmd.AddCommand(resourcesListCmd, resourcesAddCmd, resourcesUnwatchCmd, resourcesRemoveCmd, resourcesSetNameCmd)
	rootCmd.AddCommand(resourcesCmd)
}

func resourceWorktreePath() (string, error) {
	if resWorktree != "" {
		return resWorktree, nil
	}
	return os.Getwd()
}

func runResourcesList(cmd *cobra.Command, args []string) error {
	wt, err := resourceWorktreePath()
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	rs, err := resources.Load(conn, wt)
	if err != nil {
		return err
	}
	if resJSON {
		b, err := resourcesJSON(rs)
		if err != nil {
			return err
		}
		fmt.Fprintln(cmd.OutOrStdout(), string(b))
		return nil
	}
	for _, r := range rs {
		marker := " "
		if r.Related {
			marker = "~"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "%s %s:%s %s\n", marker, r.Type, r.ID, r.URL)
	}
	return nil
}

func runResourcesAdd(cmd *cobra.Command, args []string) error {
	wt, err := resourceWorktreePath()
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	return resources.Add(conn, wt, resources.Resource{
		Type: args[0], ID: args[1], URL: resURL, Related: resRelated,
	})
}

func runResourcesUnwatch(cmd *cobra.Command, args []string) error {
	wt, err := resourceWorktreePath()
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	return resources.Unwatch(conn, wt, args[0], args[1])
}

func runResourcesSetName(cmd *cobra.Command, args []string) error {
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	return resources.SetMetaAt(conn, args[0], args[1], resName, resDescription, resUpdatedAt)
}

func runResourcesRemove(cmd *cobra.Command, args []string) error {
	wt, err := resourceWorktreePath()
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	return resources.Remove(conn, wt, args[0], args[1])
}
