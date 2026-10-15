package setup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/config"
)

func answer(t *testing.T, answers map[string]bool) *[]bool {
	t.Helper()
	var defaults []bool
	orig := confirmDefault
	confirmDefault = func(prompt string, def bool) bool {
		defaults = append(defaults, def)
		for name, a := range answers {
			if strings.Contains(prompt, name) {
				return a
			}
		}
		return def
	}
	t.Cleanup(func() { confirmDefault = orig })
	return &defaults
}

func TestConfigureWatchersWritesOnlyChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("# mine\nworktrees_base: ~/wt\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	defaults := answer(t, map[string]bool{"Slack": false})
	on, err := configureWatchers(path, config.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if !on[config.ServiceGitHub] || !on[config.ServiceJira] || on[config.ServiceSlack] {
		t.Fatalf("on = %v", on)
	}
	for i, d := range *defaults {
		if !d {
			t.Fatalf("prompt %d defaulted to no; a new config defaults every watcher to yes", i)
		}
	}
	data, _ := os.ReadFile(path)
	if s := string(data); !strings.Contains(s, "# mine") || !strings.Contains(s, "watchers:\n    slack: false\n") || strings.Contains(s, "github") {
		t.Fatalf("file:\n%s", s)
	}
}

// The default is the current state, so --yes keeps a watcher the user
// turned off, off, and writes nothing.
func TestConfigureWatchersDefaultsToCurrentState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	orig := "worktrees_base: ~/wt\nwatchers:\n    jira: false\n"
	if err := os.WriteFile(path, []byte(orig), 0o600); err != nil {
		t.Fatal(err)
	}
	var cfg config.Config
	cfg.Watchers.SetEnabled(config.ServiceJira, false)
	answer(t, nil)
	on, err := configureWatchers(path, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if on[config.ServiceJira] {
		t.Fatal("jira should stay off")
	}
	if data, _ := os.ReadFile(path); string(data) != orig {
		t.Fatalf("unchanged answers rewrote the file:\n%s", data)
	}
}

func TestWatcherOffMessage(t *testing.T) {
	if got := WatcherOffMessage(config.ServiceGitHub); got != "Existing GitHub resources will still appear, but worktree will not connect to GitHub. No new activity will appear and linked resources will not update." {
		t.Fatal(got)
	}
	if got := WatcherOffMessage(config.ServiceSlack); !strings.HasSuffix(got, "No new activity will appear and threads will not be interactable.") {
		t.Fatal(got)
	}
}
