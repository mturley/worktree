package setup

import (
	"fmt"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/ui"
)

// DefaultGitHubBotUsernames seed worktree's config.yaml github.bot_usernames
// on install: patterns for accounts GitHub reports as ordinary users that are
// really automation (watcher's botmatch globs). "*ci-bot*" catches CI
// accounts such as rhods-ci-bot.
var DefaultGitHubBotUsernames = []string{"*ci-bot*"}

// needsGitHubBotSeed reports whether the config at path has never had a
// github block. A cleared list is still a block (the Settings modal keeps
// `github: {bot_usernames: []}`), so a user who emptied it is not reseeded. A
// config that can't be read is left alone.
func needsGitHubBotSeed(path string) bool {
	cur, _, err := config.ReadEditable(path)
	return err == nil && !cur.HasGitHubBlock
}

// seedGitHubBotUsernames writes DefaultGitHubBotUsernames to the config at
// path when it has no github block, keeping everything else.
func seedGitHubBotUsernames(path string) error {
	cur, _, err := config.ReadEditable(path)
	if err != nil {
		return err
	}
	if cur.HasGitHubBlock {
		return nil
	}
	cur.GitHubBotUsernames = append([]string(nil), DefaultGitHubBotUsernames...)
	if _, err := config.WriteEditable(path, cur); err != nil {
		return err
	}
	fmt.Printf("  %s GitHub bot usernames: %v (edit in Settings → Connected Services → GitHub)\n", ui.Green("✓"), DefaultGitHubBotUsernames)
	return nil
}
