package setup

import (
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/config"
)

const tipsConfigPath = "~/.config/worktree/config.yaml"

func TestGettingStartedNamesTheCommandsAndPassword(t *testing.T) {
	t.Parallel()
	got := GettingStarted(tipsConfigPath, config.UIConfig{})
	for _, want := range []string{
		"worktree ui", "http://127.0.0.1:8475", "ui.password", tipsConfigPath,
		"worktree add my-feature", "worktree add 1234", "worktree list", "worktree info [path]",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("getting started tips missing %q:\n%s", want, got)
		}
	}
}

func TestGettingStartedPhoneAddress(t *testing.T) {
	t.Parallel()
	remote := config.UIConfig{
		HTTPSPort:    8476,
		AllowedHosts: []string{"my-mac.local", "192.168.1.5"},
		TLS:          config.UITLSConfig{CertFile: "c.pem", KeyFile: "k.pem"},
	}
	t.Run("remote access on: its address and the CA", func(t *testing.T) {
		t.Parallel()
		got := GettingStarted(tipsConfigPath, remote)
		for _, want := range []string{"https://my-mac.local:8476", "~/.config/worktree/ui-ca.pem"} {
			if !strings.Contains(got, want) {
				t.Errorf("missing %q:\n%s", want, got)
			}
		}
	})
	off := remote
	off.RemoteAccessDisabled = true
	for name, cfg := range map[string]config.UIConfig{"never set up": {}, "turned off": off} {
		t.Run(name+": how to turn it on", func(t *testing.T) {
			t.Parallel()
			got := GettingStarted(tipsConfigPath, cfg)
			if strings.Contains(got, "my-mac.local") {
				t.Errorf("offers an address that isn't served:\n%s", got)
			}
			for _, want := range []string{"port 8476", "worktree setup", "remote access"} {
				if !strings.Contains(got, want) {
					t.Errorf("missing %q:\n%s", want, got)
				}
			}
		})
	}
}
