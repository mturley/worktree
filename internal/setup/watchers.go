package setup

import (
	"fmt"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/ui"
)

// confirmDefault is a package var so tests can answer the prompts.
var confirmDefault = ui.ConfirmDefault

// serviceNames are the display names, in prompt order.
var serviceNames = map[string]string{
	config.ServiceGitHub: "GitHub",
	config.ServiceJira:   "Jira",
	config.ServiceSlack:  "Slack",
}

// WatcherOffMessage explains what turning svc's watcher off means. The
// Settings modal shows the same words (ConnectedServicesPanel).
func WatcherOffMessage(svc string) string {
	name := serviceNames[svc]
	detail := "No new activity will appear and linked resources will not update."
	if svc == config.ServiceSlack {
		detail = "No new activity will appear and threads will not be interactable."
	}
	return fmt.Sprintf("Existing %s resources will still appear, but worktree will not connect to %s. %s", name, name, detail)
}

// watcherPrompt states svc's current watcher state and asks whether it
// should be on, so the question reads right whichever state it is in.
func watcherPrompt(svc string, enabled bool) string {
	if enabled {
		return fmt.Sprintf("  The %s watcher is enabled. Keep it enabled?", serviceNames[svc])
	}
	return fmt.Sprintf("  The %s watcher is disabled. Enable it?", serviceNames[svc])
}

// configureWatchers asks whether each service's watcher should be on. The
// default is the current state — on, unless it was turned off — so --yes
// (how `make install` runs setup) never re-enables one the user disabled.
// Only a changed answer is written, and only to the watchers keys. Returns
// the resulting state per service.
func configureWatchers(configPath string, cfg config.Config) (map[string]bool, error) {
	fmt.Println()
	fmt.Println(ui.Bold("Watchers:"))
	enabled := map[string]bool{}
	changed := false
	for _, svc := range config.Services {
		cur := cfg.Watchers.Enabled(svc)
		on := confirmDefault(watcherPrompt(svc, cur), cur)
		if !on {
			fmt.Printf("    %s\n", ui.Dim(WatcherOffMessage(svc)))
		}
		enabled[svc] = on
		changed = changed || on != cur
	}
	if !changed {
		return enabled, nil
	}
	e, _, err := config.ReadEditable(configPath)
	if err != nil {
		return enabled, err
	}
	e.WatchersDisabled = map[string]bool{}
	for svc, on := range enabled {
		if !on {
			e.WatchersDisabled[svc] = true
		}
	}
	if _, err := config.WriteEditable(configPath, e); err != nil {
		return enabled, err
	}
	fmt.Printf("  %s Saved watcher settings to %s\n", ui.Green("✓"), ui.ShortPath(configPath))
	return enabled, nil
}
