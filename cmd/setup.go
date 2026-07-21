package cmd

import (
	"fmt"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/setup"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

var setupYes bool
var setupUninstall bool

var setupCmd = &cobra.Command{
	Use:     "setup",
	Short:   "Configure worktree for first use",
	GroupID: "admin",
	RunE:    runSetup,
}

func init() {
	setupCmd.Flags().BoolVarP(&setupYes, "yes", "y", false, "Skip confirmation prompts")
	setupCmd.Flags().BoolVar(&setupUninstall, "uninstall", false, "Remove worktree configuration")
	rootCmd.AddCommand(setupCmd)
}

func runSetup(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	if setupUninstall {
		return runUninstall(cfg)
	}

	plan := setup.BuildPlan(cfg)
	plan.Preview()
	fmt.Println()

	if !plan.HasWork() {
		return nil
	}

	if !setupYes {
		if !ui.Confirm("Proceed?") {
			fmt.Println("Cancelled.")
			return nil
		}
	}

	return plan.Execute()
}

func runUninstall(cfg config.Config) error {
	rc := setup.DetectShellRC()
	configPath := config.ConfigPath()

	setup.PreviewUninstall(rc, configPath)
	fmt.Println()

	if !setupYes {
		if !ui.Confirm("Proceed?") {
			fmt.Println("Cancelled.")
			return nil
		}
	}

	return setup.ExecuteUninstall(rc, configPath)
}
