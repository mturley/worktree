package slackcreds

import (
	"fmt"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/config"
)

func fromConfig(cfg *wconfig.Config) (token, cookie, domain string, err error) {
	creds, err := cfg.Slack()
	if err != nil {
		return "", "", "", err
	}
	return creds.Token, creds.Cookie, creds.WorkspaceDomain, nil
}

// Load reads Slack credentials from worktree's watcher-auth.yaml.
func Load() (token, cookie, domain string, err error) {
	cfg, err := wconfig.Load(config.WatcherAuthPath())
	if err != nil {
		return "", "", "", fmt.Errorf("loading watcher credentials: %w", err)
	}
	return fromConfig(cfg)
}

// Client builds a Slack API client from the stored credentials.
func Client() (slack.Client, string, error) {
	token, cookie, domain, err := Load()
	if err != nil {
		return nil, "", err
	}
	return slack.New(token, cookie), domain, nil
}
