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
	Type    string `json:"type"`
	ID      string `json:"id"`
	URL     string `json:"url"`
	Primary bool   `json:"primary"`
}

func resourcesJSON(rs []resources.Resource) ([]byte, error) {
	out := make([]resourceJSON, 0, len(rs)) // ensures [] not null when empty
	for _, r := range rs {
		out = append(out, resourceJSON{Type: r.Type, ID: r.ID, URL: r.URL, Primary: !r.Related})
	}
	return json.Marshal(out)
}

var (
	resWorktree string
	resJSON     bool
	resURL      string
	resRelated  bool
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

func init() {
	resourcesListCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesListCmd.Flags().BoolVar(&resJSON, "json", false, "machine-readable JSON output")
	resourcesAddCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesAddCmd.Flags().StringVar(&resURL, "url", "", "resource URL")
	resourcesAddCmd.Flags().BoolVar(&resRelated, "related", false, "mark as related (not primary)")
	resourcesUnwatchCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesRemoveCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")

	resourcesCmd.AddCommand(resourcesListCmd, resourcesAddCmd, resourcesUnwatchCmd, resourcesRemoveCmd)
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
