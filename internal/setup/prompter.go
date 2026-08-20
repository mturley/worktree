// internal/setup/prompter.go
package setup

import (
	"fmt"
	"strings"

	"github.com/mturley/watcher/credsetup"
	"github.com/mturley/worktree/internal/ui"
)

// Prompter implements credsetup.Prompter over worktree's terminal ui
// package, so the shared watcher credsetup.TestAndRepair flow can drive
// worktree's interactive `worktree setup` the same way it drives any other
// consumer.
type Prompter struct{}

// Info prints a status line. Lines ending in "ok" are colored green, lines
// containing "failed" are colored red; everything else (progress messages
// like "Testing GitHub credentials...") is printed plain.
func (Prompter) Info(msg string) {
	switch {
	case strings.HasSuffix(msg, "ok"):
		fmt.Printf("  %s\n", ui.Green(msg))
	case strings.Contains(msg, "failed"):
		fmt.Printf("  %s\n", ui.Red(msg))
	default:
		fmt.Printf("  %s\n", msg)
	}
}

// Confirm asks a yes/no question via ui.Confirm.
func (Prompter) Confirm(msg string) bool {
	return ui.Confirm("  " + msg)
}

// PromptToken prints the given instructions and asks for a single secret
// token via ui.PromptSecret.
func (Prompter) PromptToken(service credsetup.Service, instructions string) string {
	fmt.Printf("  %s\n", instructions)
	return ui.PromptSecret(fmt.Sprintf("  New %s token", service))
}

// PromptSlack acquires a Slack token + cookie pair via worktree's existing
// Slack credential acquisition flow (automatic browser extraction, falling
// back to manual devtools instructions). It performs no validation and
// saves nothing — credsetup.TestAndRepair validates the result and, on
// success, writes it into the config itself.
func (Prompter) PromptSlack(_ string) (token, cookie string) {
	token, cookie, err := acquireSlackCreds()
	if err != nil {
		fmt.Printf("  %s %v\n", ui.Red("!"), err)
		return "", ""
	}
	return token, cookie
}
