package setup

import (
	"testing"

	"github.com/mturley/watcher/credsetup"
	"github.com/mturley/worktree/internal/ui"
)

func stubGH(t *testing.T, tok string, ok bool) {
	t.Helper()
	orig := ghCLIToken
	ghCLIToken = func() (string, bool) { return tok, ok }
	t.Cleanup(func() { ghCLIToken = orig })
}

func TestPromptTokenOffersGHToken(t *testing.T) {
	stubGH(t, "gho_fromgh", true)
	asked := 0
	orig := confirmDefault
	confirmDefault = func(string, bool) bool { asked++; return true }
	t.Cleanup(func() { confirmDefault = orig })
	if got := (Prompter{}).PromptToken(credsetup.GitHub, "paste one"); got != "gho_fromgh" || asked != 1 {
		t.Fatalf("got %q after %d prompts", got, asked)
	}
}

// Declining, or gh not logged in, falls back to pasting a token; only
// GitHub ever gets the offer.
func TestPromptTokenFallsBackToPaste(t *testing.T) {
	ui.SetNonInteractive(true) // the paste prompt answers "" instead of blocking
	t.Cleanup(func() { ui.SetNonInteractive(false) })
	orig := confirmDefault
	asked := 0
	confirmDefault = func(string, bool) bool { asked++; return false }
	t.Cleanup(func() { confirmDefault = orig })

	stubGH(t, "gho_fromgh", true)
	if got := (Prompter{}).PromptToken(credsetup.GitHub, "paste one"); got == "gho_fromgh" {
		t.Fatal("a declined offer must not use gh's token")
	}
	stubGH(t, "", false)
	(Prompter{}).PromptToken(credsetup.GitHub, "paste one")
	stubGH(t, "gho_fromgh", true)
	(Prompter{}).PromptToken(credsetup.Jira, "paste one")
	if asked != 1 {
		t.Fatalf("offered %d times; want once (GitHub with gh logged in)", asked)
	}
}
