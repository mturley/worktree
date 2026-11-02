package cmd

import (
	"fmt"
	"io"
	"sort"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/listeners"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

var portsCmd = &cobra.Command{
	Use:   "ports",
	Short: "Show allocated port ranges",
	Long: "Show the allocated port ranges.\n\n" +
		"--listening also scans the machine for listening TCP ports (with lsof) and\n" +
		"attributes each to the worktree whose directory its process runs in. A port\n" +
		"outside its worktree's reserved range is marked.",
	GroupID: "worktree",
	Args:    cobra.NoArgs,
	RunE:    runPorts,
}

var (
	portsJSON      bool
	portsListening bool
)

// listenersRunner runs lsof for `ports --listening`; tests stub it.
var listenersRunner listeners.Runner = listeners.ExecRunner

func init() {
	portsCmd.Flags().BoolVar(&portsJSON, "json", false, "machine-readable JSON output")
	portsCmd.Flags().BoolVar(&portsListening, "listening", false, "also scan for listening ports and attribute them to worktrees")
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

	var snap *listeners.Snapshot
	if portsListening {
		srv, err := headlessServer(conn)
		if err != nil {
			return err
		}
		s, err := srv.ScanListeners(cmd.Context(), listenersRunner)
		if err != nil {
			return fmt.Errorf("scan listening ports: %w", err)
		}
		snap = &s
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
		fields := map[string]any{"allocations": out}
		if snap != nil {
			fields["listeners"] = snap
		}
		return printJSON(cmd.OutOrStdout(), fields)
	}

	w := cmd.OutOrStdout()
	if len(allocs) == 0 {
		fmt.Fprintln(w, "No port ranges allocated.")
	} else {
		fmt.Fprintln(w, ui.Bold("Allocated port ranges:"))
		for _, a := range allocs {
			fmt.Fprintf(w, "  %s  %s\n", ui.Cyan(a.Range()), a.Name)
		}
	}
	if snap != nil {
		printListeners(w, *snap)
	}
	return nil
}

// printListeners prints one line per listening port, grouped by worktree
// path; ports no worktree owns come last under "(none)".
func printListeners(w io.Writer, snap listeners.Snapshot) {
	fmt.Fprintln(w, ui.Bold("Listening ports:"))
	paths := make([]string, 0, len(snap.Ports))
	for p := range snap.Ports {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	n := 0
	for _, p := range paths {
		for _, lp := range snap.Ports[p] {
			owner := p
			if owner == "" {
				owner = "(none)"
			}
			marker := ""
			if !lp.InRange && p != "" {
				marker = "  " + ui.Yellow("(outside its range)")
			}
			fmt.Fprintf(w, "  :%d  %s (%d)  %s%s\n", lp.Port, lp.Process, lp.PID, owner, marker)
			n++
		}
	}
	if n == 0 {
		fmt.Fprintln(w, "  none")
	}
}
