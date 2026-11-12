package setup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/config"
)

func TestSeedGitHubBotsIntoWorktreeConfig(t *testing.T) {
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
	cur, _, err := config.ReadEditable(missing)
	if err != nil {
		t.Fatal(err)
	}
	if got := cur.GitHubBotUsernames; len(got) != 1 || got[0] != "*ci-bot*" {
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
	cur, _, err = config.ReadEditable(withJira)
	if err != nil {
		t.Fatal(err)
	}
	if got := cur.JiraBotUsernames; len(got) != 1 || got[0] != "jbot" {
		t.Fatalf("jira list lost: %v", got)
	}
	if got := cur.GitHubBotUsernames; len(got) != 1 || got[0] != "*ci-bot*" {
		t.Fatalf("not seeded: %v", got)
	}
}

func TestSeedSkipsClearedGitHubBots(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	for name, body := range map[string]string{
		"cleared.yaml": "github:\n  bot_usernames: []\n",
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
		if string(data) != body || strings.Contains(string(data), "ci-bot") {
			t.Errorf("%s: changed:\n%s", name, data)
		}
	}
}
