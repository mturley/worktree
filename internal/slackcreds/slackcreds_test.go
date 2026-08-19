package slackcreds

import (
	wconfig "github.com/mturley/watcher/config"
	"testing"
)

func TestFromConfig(t *testing.T) {
	cfg := &wconfig.Config{Services: wconfig.Services{Slack: &wconfig.SlackConfig{
		Token: "xoxc-t", Cookie: "xoxd-c", WorkspaceDomain: "acme.slack.com",
	}}}
	tok, ck, dom, err := fromConfig(cfg)
	if err != nil || tok != "xoxc-t" || ck != "xoxd-c" || dom != "acme.slack.com" {
		t.Fatalf("got %q %q %q err=%v", tok, ck, dom, err)
	}
}

func TestFromConfigNotConfigured(t *testing.T) {
	if _, _, _, err := fromConfig(&wconfig.Config{}); err == nil {
		t.Fatal("expected not-configured error")
	}
}
