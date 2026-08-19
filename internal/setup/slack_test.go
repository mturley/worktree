package setup

import (
	"testing"

	wconfig "github.com/mturley/watcher/config"
)

func TestWriteSlackCreds(t *testing.T) {
	cfg := &wconfig.Config{}
	writeSlackCreds(cfg, "xoxc-t", "xoxd-c", "acme.slack.com")
	if cfg.Services.Slack == nil || cfg.Services.Slack.Token != "xoxc-t" ||
		cfg.Services.Slack.Cookie != "xoxd-c" || cfg.Services.Slack.WorkspaceDomain != "acme.slack.com" {
		t.Fatalf("got %+v", cfg.Services.Slack)
	}
}

func TestWriteSlackCredsOverwritesExisting(t *testing.T) {
	cfg := &wconfig.Config{Services: wconfig.Services{Slack: &wconfig.SlackConfig{
		Token: "old", Cookie: "old", WorkspaceDomain: "old.slack.com",
	}}}
	writeSlackCreds(cfg, "xoxc-new", "xoxd-new", "new.slack.com")
	if cfg.Services.Slack.Token != "xoxc-new" || cfg.Services.Slack.Cookie != "xoxd-new" ||
		cfg.Services.Slack.WorkspaceDomain != "new.slack.com" {
		t.Fatalf("got %+v", cfg.Services.Slack)
	}
}
