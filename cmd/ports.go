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

func init() {
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
