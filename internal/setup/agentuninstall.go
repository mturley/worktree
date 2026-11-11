package setup

import (
	"fmt"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/worktree/internal/ui"
)

// agentUninstall names everything uninstall touches for agents: the skills, and
// worktree's registration in the watcher config.
type agentUninstall struct {
	Skill       skillDeps
	WatcherPath string
	Consumer    string
}

func defaultAgentUninstall(consumer string) agentUninstall {
	return agentUninstall{Skill: defaultSkillDeps(), WatcherPath: wconfig.DefaultPath(), Consumer: consumer}
}

func previewAgentUninstall(u agentUninstall) {
	planSkillsUninstall(u.Skill).Preview()
	// A config that can't be read may still register worktree, and unregistering
	// is what reports the failure, so it stays in the preview.
	if registered, err := watcherConsumerRegistered(u.WatcherPath, u.Consumer); registered || err != nil {
		fmt.Println("  • Unregister worktree's database from the watcher config")
	}
}

// runAgentUninstall removes the skills and unregisters the consumer. A failure
// in either is a warning and doesn't stop the other.
func runAgentUninstall(u agentUninstall) {
	if err := applySkills(u.Skill, planSkillsUninstall(u.Skill)); err != nil {
		fmt.Printf("  %s Removing worktree's skills: %v\n", ui.Yellow("!"), err)
	}
	removed, err := unregisterWatcherConsumer(u.WatcherPath, u.Consumer)
	if err != nil {
		fmt.Printf("  %s Unregistering from the watcher config: %v\n", ui.Yellow("!"), err)
	} else if removed {
		fmt.Printf("  %s Unregistered worktree's database from the watcher config\n", ui.Green("✓"))
	}
}

// watcherConsumerRegistered reports whether the watcher config at path lists
// the consumer. A missing file is simply not registered: Load returns it empty.
func watcherConsumerRegistered(path, consumer string) (bool, error) {
	cfg, err := wconfig.Load(path)
	if err != nil {
		return false, err
	}
	_, ok := cfg.Consumers()[consumer]
	return ok, nil
}

// unregisterWatcherConsumer saves only when there is something to remove, so it
// never creates or rewrites the credentials file otherwise.
func unregisterWatcherConsumer(path, consumer string) (removed bool, err error) {
	cfg, err := wconfig.Load(path)
	if err != nil {
		return false, err
	}
	if _, ok := cfg.Consumers()[consumer]; !ok {
		return false, nil
	}
	cfg.UnregisterConsumer(consumer)
	if err := cfg.Save(path); err != nil {
		return false, err
	}
	return true, nil
}
