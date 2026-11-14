package setup

import (
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/config"
)

const tipsConfigPath = "~/.config/worktree/config.yaml"

func TestGettingStartedNamesTheCommandsAndPassword(t *testing.T) {
	t.Parallel()
	got := GettingStarted(tipsConfigPath, config.UIConfig{}, true)
	for _, want := range []string{
		"wt ui", "http://127.0.0.1:8475", "ui.password", tipsConfigPath,
		"wt add my-feature", "wt add 1234", "wt list", "wt info [path]",
		"wt cd [name]", "main checkout",
		"wt --help",
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
		got := GettingStarted(tipsConfigPath, remote, true)
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
			got := GettingStarted(tipsConfigPath, cfg, true)
			if strings.Contains(got, "my-mac.local") {
				t.Errorf("offers an address that isn't served:\n%s", got)
			}
			for _, want := range []string{"port 8476", "wt setup", "remote access"} {
				if !strings.Contains(got, want) {
					t.Errorf("missing %q:\n%s", want, got)
				}
			}
		})
	}
}

func TestGettingStartedUncoloured(t *testing.T) {
	t.Parallel()
	if got := GettingStarted(tipsConfigPath, config.UIConfig{}, false); strings.Contains(got, "\033[") {
		t.Errorf("uncoloured tips carry escape codes:\n%q", got)
	}
}

func TestGettingStartedIntroducesWtBeforeUsingIt(t *testing.T) {
	t.Parallel()
	got := GettingStarted(tipsConfigPath, config.UIConfig{}, false)
	intro := strings.Index(got, "wt is short for worktree")
	first := strings.Index(got, "wt ui")
	if intro < 0 || first < 0 || intro > first {
		t.Fatalf("the wt alias must be explained before the first example:\n%s", got)
	}
}

func TestGettingStartedExamplesAllUseWt(t *testing.T) {
	t.Parallel()
	for _, ui := range []config.UIConfig{{}, {
		HTTPSPort:    8476,
		AllowedHosts: []string{"my-mac.local"},
		TLS:          config.UITLSConfig{CertFile: "c.pem", KeyFile: "k.pem"},
	}} {
		got := GettingStarted(tipsConfigPath, ui, false)
		for _, long := range []string{"worktree ui", "worktree add", "worktree setup", "worktree list", "worktree info", "worktree cd", "worktree --help", "worktree <command>"} {
			if strings.Contains(got, long) {
				t.Errorf("example uses %q instead of wt:\n%s", long, got)
			}
		}
	}
}
