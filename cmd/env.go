package cmd

import (
	"fmt"
	"os"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/shellenv"
	"github.com/spf13/cobra"
)

var envCmd = &cobra.Command{
	Use:   "env [path]",
	Short: "Print shell exports for the current (or given) worktree (eval this)",
	Long:  "Prints `export ...` lines computed from the worktree database. Add\n`eval \"$(worktree env)\"` to your shell's chpwd hook. Prints nothing outside a worktree.",
	Args:  cobra.MaximumNArgs(1),
	// Silence usage/errors so a failing eval never spams the shell.
	SilenceUsage:  true,
	SilenceErrors: true,
	RunE:          runEnv,
}

func init() {
	rootCmd.AddCommand(envCmd)
}

func runEnv(cmd *cobra.Command, args []string) error {
	path := "."
	if len(args) == 1 {
		path = args[0]
	}
	abs, err := os.Getwd()
	if err == nil && path == "." {
		path = abs
	}

	conn, err := wdb.Open()
	if err != nil {
		return nil // never break the shell on a DB error
	}
	defer conn.Close()

	lines, err := shellenv.Lines(conn, path)
	if err != nil {
		return nil
	}
	for _, l := range lines {
		fmt.Fprintln(cmd.OutOrStdout(), l)
	}
	return nil
}
