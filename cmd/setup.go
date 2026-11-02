package cmd

import (
	"fmt"
	"os"
	"runtime"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/setup"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

const consumerName = "worktree"

var setupYes bool
var setupUninstall, setupUninstallMacApp bool

var setupCmd = &cobra.Command{
	Use:     "setup",
	Short:   "Configure worktree for first use",
	GroupID: "admin",
	RunE:    runSetup,
}

func init() {
	setupCmd.Flags().BoolVarP(&setupYes, "yes", "y", false,
		"Run without asking: skip confirmations and answer every other question with its default")
	setupCmd.Flags().BoolVar(&setupUninstall, "uninstall", false, "Remove worktree configuration")
	setupCmd.Flags().BoolVar(&setupUninstallMacApp, "uninstall-mac-app", false, "Remove only the macOS menu bar app")
	setupCmd.MarkFlagsMutuallyExclusive("uninstall", "uninstall-mac-app")
	rootCmd.AddCommand(setupCmd)
	setupSlackCmd.Flags().BoolVar(&setupSlackForce, "force", false,
		"Skip testing the stored credentials and always capture new ones")
	setupCmd.AddCommand(setupSlackCmd)
}

var setupSlackForce bool

var setupSlackCmd = &cobra.Command{
	Use:   "slack",
	Short: "Capture Slack credentials from a browser session",
	Long: "Tests the stored Slack credentials, and captures new ones from a browser\n" +
		"session (Playwright) when they are missing, rejected, or you ask for fresh ones.",
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		return setup.RunSlackSetup(setupSlackForce)
	},
}

func runSetup(cmd *cobra.Command, args []string) error {
	// --yes is how `make install` runs setup, often with nobody at the
	// terminal. Skipping the "Proceed?" confirmations is not enough: later
	// steps (config, Jira prefixes, credentials, web UI) ask questions of
	// their own, and each one used to block the install waiting on stdin.
	ui.SetNonInteractive(setupYes)

	if setupUninstallMacApp {
		return runUninstallMacApp()
	}

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
		printGettingStarted()
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

	printGettingStarted()
	return nil
}

// printGettingStarted ends an interactive setup with tips for what to do
// next. Not with --yes: `make install` runs setup that way on every
// rebuild, and the tips would be noise there.
func printGettingStarted() {
	if ui.NonInteractive() {
		return
	}
	// Reloaded: the run may have just turned remote access on or off.
	cfg, err := config.Load()
	if err != nil {
		return
	}
	fmt.Println()
	fmt.Print(setup.GettingStarted(ui.ShortPath(config.ConfigPath()), cfg.UI, true))
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

	watcherPath := wconfig.DefaultPath()
	// A config that can't be read may still register worktree, and unregistering
	// is what reports the failure, so it stays in the preview.
	registered, err := watcherConsumerRegistered(watcherPath)
	setup.PreviewUninstall(rc, configPath, registered || err != nil)
	fmt.Println()

	if !setupYes {
		if !ui.Confirm("Proceed?") {
			fmt.Println("Cancelled.")
			return nil
		}
	}

	uninstallErr := setup.ExecuteUninstall(rc, configPath)
	if err := unregisterWatcherConsumer(watcherPath); err != nil {
		fmt.Printf("  %s Unregistering from the watcher config: %v\n", ui.Yellow("!"), err)
	} else if registered {
		fmt.Printf("  %s Unregistered worktree's database from the watcher config\n", ui.Green("✓"))
	}
	return uninstallErr
}

// watcherConsumerRegistered reports whether the watcher config at path lists
// worktree. A missing file is simply not registered: Load returns it as empty.
func watcherConsumerRegistered(path string) (bool, error) {
	cfg, err := wconfig.Load(path)
	if err != nil {
		return false, err
	}
	_, ok := cfg.Consumers()[consumerName]
	return ok, nil
}

// unregisterWatcherConsumer undoes registerWatcherConsumer. It saves only when
// there is something to remove, so it never creates or rewrites the
// credentials file otherwise.
func unregisterWatcherConsumer(path string) error {
	cfg, err := wconfig.Load(path)
	if err != nil {
		return err
	}
	if _, ok := cfg.Consumers()[consumerName]; !ok {
		return nil
	}
	cfg.UnregisterConsumer(consumerName)
	return cfg.Save(path)
}

func runUninstallMacApp() error {
	if runtime.GOOS != "darwin" {
		fmt.Println("The menu bar app is macOS only.")
		return nil
	}
	if !setup.MacAppUninstallPreview() {
		fmt.Println("The menu bar app is not installed.")
		return nil
	}
	fmt.Println()
	if !setupYes && !ui.Confirm("Proceed?") {
		fmt.Println("Cancelled.")
		return nil
	}
	return setup.MacAppUninstall()
}
