// internal/setup/prompter.go
package setup

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/mturley/watcher/credsetup"
	"github.com/mturley/worktree/internal/ui"
)

// Prompter implements credsetup.Prompter over worktree's terminal ui
// package, so the shared watcher credsetup.TestAndRepair flow can drive
// worktree's interactive `worktree setup` the same way it drives any other
// consumer.
//
// out is where Info writes; it defaults to os.Stdout when zero, and is
// overridable in tests to assert Info's color routing.
type Prompter struct {
	out io.Writer
}

// Info prints a status line, coloring it by the outcome the message conveys.
// The classification matches the exact wording credsetup.TestAndRepair emits
// today ("<Service>: ok" on success; "...failed..." / "...invalid..." on
// failure) — re-check it if the pinned credsetup version changes its
// messages. Anything else (progress lines like "Testing GitHub
// credentials...") prints plain.
func (p Prompter) Info(msg string) {
	w := p.out
	if w == nil {
		w = os.Stdout
	}
	switch {
	case strings.Contains(msg, ": ok"):
		fmt.Fprintf(w, "  %s\n", ui.Green(msg))
	case strings.Contains(msg, "failed"), strings.Contains(msg, "invalid"):
		fmt.Fprintf(w, "  %s\n", ui.Red(msg))
	default:
		fmt.Fprintf(w, "  %s\n", msg)
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

// PromptJira asks for the Jira site URL (host) and account email needed for
// first-time (greenfield) Jira setup, when no host/email is configured yet.
// Returning an empty host or email signals credsetup to abort/skip.
func (Prompter) PromptJira(instructions string) (host, email string) {
	fmt.Printf("  %s\n", instructions)
	host = ui.PromptLine("  Jira site URL (e.g. your-org.atlassian.net)")
	if host == "" {
		return "", ""
	}
	email = ui.PromptLine("  Jira account email")
	return host, email
}
