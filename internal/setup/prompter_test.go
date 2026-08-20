package setup

import (
	"testing"

	"github.com/mturley/watcher/credsetup"
)

// TestPrompterConfirm exercises the thin Confirm mapping. Interactive
// prompts (Confirm/PromptToken/PromptSecret) read from stdin, so a full
// simulation is left to manual smoke testing; here we only verify the
// Prompter type satisfies credsetup.Prompter and that Info's routing logic
// doesn't panic across the message shapes credsetup actually sends.
func TestPrompterImplementsCredsetupInterface(t *testing.T) {
	var _ credsetup.Prompter = Prompter{}
}

func TestPrompterInfoDoesNotPanic(t *testing.T) {
	p := Prompter{}
	msgs := []string{
		"Testing GitHub credentials...",
		"GitHub: ok",
		"GitHub: failed (bad credentials)",
		"Jira is not configured. Run the full Jira setup to provide a host and email before repairing the token.",
	}
	for _, msg := range msgs {
		p.Info(msg)
	}
}
