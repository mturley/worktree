package setup

import (
	"fmt"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/worktree/internal/ui"
)

// DefaultGitHubBotUsernames seed the watcher config's github.bot_usernames on
// install: patterns for accounts GitHub reports as ordinary users that are
// really automation (watcher's botmatch globs). "*ci-bot*" catches CI
// accounts such as rhods-ci-bot.
var DefaultGitHubBotUsernames = []string{"*ci-bot*"}

// needsGitHubBotSeed reports whether the watcher config at path has never had
// a github block. A cleared list is still a block (the Settings modal keeps
// `github: {}`), so a user who emptied it is not reseeded. A config that
// can't be read is left alone.
func needsGitHubBotSeed(path string) bool {
	cfg, err := wconfig.LoadConfig(path)
	return err == nil && cfg.GitHub == nil
}

// seedGitHubBotUsernames writes DefaultGitHubBotUsernames to the watcher
// config at path when it has no github block, keeping everything else.
func seedGitHubBotUsernames(path string) error {
	cfg, err := wconfig.LoadConfig(path)
	if err != nil {
		return err
	}
	if cfg.GitHub != nil {
		return nil
	}
	cfg.GitHub = &wconfig.GitHubBehavior{BotUsernames: append([]string(nil), DefaultGitHubBotUsernames...)}
	if err := wconfig.SaveConfig(path, cfg); err != nil {
		return err
	}
	fmt.Printf("  %s GitHub bot usernames: %v (edit in Settings → Connected Services → GitHub)\n", ui.Green("✓"), DefaultGitHubBotUsernames)
	return nil
}
