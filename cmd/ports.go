package cmd

import (
	"fmt"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

var portsCmd = &cobra.Command{
	Use:     "ports",
	Short:   "Show allocated port ranges",
	GroupID: "worktree",
	RunE:    runPorts,
}

var portsJSON bool

func init() {
	portsCmd.Flags().BoolVar(&portsJSON, "json", false, "machine-readable JSON output")
	rootCmd.AddCommand(portsCmd)
}

func runPorts(cmd *cobra.Command, args []string) error {
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()

	allocs, err := ports.LoadAllocations(conn)
	if err != nil {
		return err
	}

	if portsJSON {
		type allocJSON struct {
			Name  string `json:"name"`
			Start int    `json:"start"`
			End   int    `json:"end"`
		}
		out := make([]allocJSON, 0, len(allocs))
		for _, a := range allocs {
			out = append(out, allocJSON{Name: a.Name, Start: a.Start(), End: a.End()})
		}
		return printJSON(cmd.OutOrStdout(), map[string]any{"allocations": out})
	}

	if len(allocs) == 0 {
		fmt.Println("No port ranges allocated.")
		return nil
	}

	fmt.Println(ui.Bold("Allocated port ranges:"))
	for _, a := range allocs {
		fmt.Printf("  %s  %s\n", ui.Cyan(a.Range()), a.Name)
	}
	return nil
}
