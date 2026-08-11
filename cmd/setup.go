package cmd

import (
	"fmt"
	"os"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/setup"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

const consumerName = "worktree"

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

	if err := plan.Execute(); err != nil {
		return err
	}

	if err := registerWatcherConsumer(); err != nil {
		fmt.Fprintf(os.Stderr, "Note: could not register worktree in watcher consumer registry: %v\n", err)
	}

	return nil
}

// registerWatcherConsumer records worktree's DB in the shared watcher
// ConsumerRegistry (~/.config/watcher/auth.yaml). Best-effort: forward-looking
// per CC-1, not required by any Phase 1 feature.
func registerWatcherConsumer() error {
	dbPath, err := wdb.Path()
	if err != nil {
		return err
	}
	cfgPath := wconfig.DefaultPath()
	cfg, err := wconfig.Load(cfgPath) // returns &Config{} if the file is absent
	if err != nil {
		return err
	}
	cfg.RegisterConsumer(consumerName, dbPath)
	return cfg.Save(cfgPath)
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
