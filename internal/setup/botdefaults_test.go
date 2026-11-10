package setup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	wconfig "github.com/mturley/watcher/config"
)

func TestSeedGitHubBotUsernames(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	// No file at all: seeded, and nothing else is invented.
	missing := filepath.Join(dir, "missing.yaml")
	if !needsGitHubBotSeed(missing) {
		t.Fatal("a missing config needs the seed")
	}
	if err := seedGitHubBotUsernames(missing); err != nil {
		t.Fatal(err)
	}
	cfg, _ := wconfig.LoadConfig(missing)
	if got := cfg.GitHubBotUsernames(); len(got) != 1 || got[0] != "*ci-bot*" {
		t.Fatalf("seeded %v", got)
	}
	if needsGitHubBotSeed(missing) {
		t.Fatal("seeded config must not need it again")
	}

	// Other settings survive the seed.
	withJira := filepath.Join(dir, "jira.yaml")
	if err := os.WriteFile(withJira, []byte("jira:\n  bot_usernames: [jbot]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := seedGitHubBotUsernames(withJira); err != nil {
		t.Fatal(err)
	}
	cfg, _ = wconfig.LoadConfig(withJira)
	if got := cfg.JiraBotUsernames(); len(got) != 1 || got[0] != "jbot" {
		t.Fatalf("jira list lost: %v", got)
	}

	// A list the user cleared (github: {}) or chose stays as it is.
	for name, body := range map[string]string{
		"cleared.yaml": "github: {}\n",
		"chosen.yaml":  "github:\n  bot_usernames: [mybot]\n",
	} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if needsGitHubBotSeed(p) {
			t.Errorf("%s: must not be reseeded", name)
		}
		if err := seedGitHubBotUsernames(p); err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(p)
		if strings.Contains(string(data), "ci-bot") {
			t.Errorf("%s: reseeded:\n%s", name, data)
		}
	}
}
