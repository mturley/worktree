package cmd

import (
	"github.com/mturley/worktree/internal/agentskill"
	"github.com/spf13/cobra"
)

var agentHelpCmd = &cobra.Command{
	Use:     "agent-help",
	Short:   "Print the worktree skill, for an AI agent without it installed",
	GroupID: "admin",
	Args:    cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		_, err := cmd.OutOrStdout().Write(agentskill.Body())
		return err
	},
}

func init() {
	rootCmd.AddCommand(agentHelpCmd)
}
