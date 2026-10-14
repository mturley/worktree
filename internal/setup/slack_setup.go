package setup

import (
	"fmt"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/watcher/credsetup"
	"github.com/mturley/worktree/internal/ui"
)

// Seams for tests.
var (
	slackTestAndRepair    = credsetup.TestAndRepair
	slackReplace          = credsetup.Replace
	slackConfirmRecapture = func() bool {
		return ui.ConfirmDefault("  Slack credentials are valid. Capture new credentials anyway?", false)
	}
)

// RunSlackSetup is `worktree setup slack`: only setup's Slack step, plus a
// way to recapture credentials that still work. It loads and, if anything
// changed, saves the watcher auth.yaml.
func RunSlackSetup(force bool) error {
	path := wconfig.DefaultPath()
	cfg, err := wconfig.Load(path)
	if err != nil {
		return fmt.Errorf("loading watcher config: %w", err)
	}
	changed, err := runSlackSetup(cfg, force)
	if err != nil {
		return err
	}
	if !changed {
		return nil
	}
	if err := cfg.Save(path); err != nil {
		return fmt.Errorf("saving watcher config: %w", err)
	}
	fmt.Printf("  %s Updated %s\n", ui.Green("✓"), ui.ShortPath(path))
	return nil
}

// runSlackSetup decides between testing, repairing and recapturing:
//   - force: capture straight away.
//   - otherwise TestAndRepair: missing creds offer setup, rejected creds
//     offer replacement. Either way that is the whole run.
//   - creds that were configured and are still valid: ask whether to
//     capture new ones anyway.
func runSlackSetup(cfg *wconfig.Config, force bool) (bool, error) {
	var p Prompter
	if force {
		return slackReplace(cfg, credsetup.Slack, p)
	}
	_, cfgErr := cfg.Slack()
	wasConfigured := cfgErr == nil
	changed, err := slackTestAndRepair(cfg, credsetup.Slack, p)
	if err != nil || changed || !wasConfigured {
		return changed, err
	}
	// Configured and unchanged: TestAndRepair found them valid, or found
	// them rejected and the user declined to replace them. Both answers
	// mean "keep what is there" except in the valid case, where the user
	// ran this command precisely to get fresh ones.
	if !slackConfirmRecapture() {
		return false, nil
	}
	return slackReplace(cfg, credsetup.Slack, p)
}
