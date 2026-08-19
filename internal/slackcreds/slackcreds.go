package slackcreds

import (
	"fmt"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/worktree/internal/slackapi"
)

func fromConfig(cfg *wconfig.Config) (token, cookie, domain string, err error) {
	creds, err := cfg.Slack()
	if err != nil {
		return "", "", "", err
	}
	return creds.Token, creds.Cookie, creds.WorkspaceDomain, nil
}

// Load reads Slack credentials from the shared watcher auth.yaml.
func Load() (token, cookie, domain string, err error) {
	cfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		return "", "", "", fmt.Errorf("loading watcher config: %w", err)
	}
	return fromConfig(cfg)
}

// Client builds a Slack API client from the stored credentials.
func Client() (slackapi.Client, string, error) {
	token, cookie, domain, err := Load()
	if err != nil {
		return nil, "", err
	}
	return slackapi.New(token, cookie), domain, nil
}
