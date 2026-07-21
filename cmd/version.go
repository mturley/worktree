package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var Version = "dev"

var versionCmd = &cobra.Command{
	Use:     "version",
	Short:   "Print version",
	GroupID: "admin",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("worktree", Version)
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
}
