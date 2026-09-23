package ui

import (
	"os"
	"testing"
)

// In non-interactive mode no prompt may read stdin: `make install` runs setup
// with nobody at the terminal, and a read there hangs forever. Stdin is
// replaced with input that would change every answer, so a prompt that reads
// it anyway is caught by its result rather than by a hang.
func TestNonInteractivePromptsTakeDefaults(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	w.WriteString("y\ny\ny\nanswer\nanswer\n2\n2\n")
	w.Close()
	oldStdin := os.Stdin
	os.Stdin = r
	SetNonInteractive(true)
	t.Cleanup(func() {
		os.Stdin = oldStdin
		SetNonInteractive(false)
		r.Close()
	})

	if Confirm("q") {
		t.Error("Confirm = true, want false (its default)")
	}
	if ConfirmDefault("q", false) {
		t.Error("ConfirmDefault(no) = true, want false")
	}
	if !ConfirmDefault("q", true) {
		t.Error("ConfirmDefault(yes) = false, want true")
	}
	if got := PromptLine("q"); got != "" {
		t.Errorf("PromptLine = %q, want empty", got)
	}
	if got := PromptLineDefault("q", "dflt"); got != "dflt" {
		t.Errorf("PromptLineDefault = %q, want dflt", got)
	}
	if got := PromptChoiceOptional("q", 3); got != 0 {
		t.Errorf("PromptChoiceOptional = %d, want 0", got)
	}
	if _, err := PromptChoice("q", 3); err == nil {
		t.Error("PromptChoice succeeded, want an error: it has no default")
	}
	if got := PromptSecret("q"); got != "" {
		t.Errorf("PromptSecret = %q, want empty", got)
	}
}
