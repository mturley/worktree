package ui

import (
	"bytes"
	"io"
	"os"
	"testing"
	"time"
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

func TestColorWanted(t *testing.T) {
	env := func(v string) func(string) string {
		return func(k string) string {
			if k == "NO_COLOR" {
				return v
			}
			return ""
		}
	}
	if !ColorWanted(true, env("")) {
		t.Error("TTY with NO_COLOR unset should want color")
	}
	if ColorWanted(true, env("1")) {
		t.Error("NO_COLOR=1 should disable color")
	}
	if ColorWanted(false, env("")) {
		t.Error("non-TTY should not want color")
	}
}

// Not parallel: SetColor changes package-level state.
func TestHelpersPlainWhenColorOff(t *testing.T) {
	t.Cleanup(func() { SetColor(true) })
	SetColor(false)
	for name, f := range map[string]func(string) string{
		"Bold": Bold, "Dim": Dim, "Red": Red, "Green": Green,
		"Yellow": Yellow, "Blue": Blue, "Cyan": Cyan,
	} {
		if got := f("x"); got != "x" {
			t.Errorf("%s(\"x\") = %q with color off, want plain", name, got)
		}
	}
	SetColor(true)
	if got := Bold("x"); got != ColorBold+"x"+ColorReset {
		t.Errorf("Bold with color on = %q", got)
	}
}

// Not parallel: swaps os.Stdout and the color switch.
func TestSpinnerPlainWhenColorOff(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	oldStdout := os.Stdout
	t.Cleanup(func() { os.Stdout = oldStdout; SetColor(true) })
	SetColor(false)
	os.Stdout = w

	s := StartSpinner("working")
	time.Sleep(200 * time.Millisecond)
	s.Stop("done")
	w.Close()
	os.Stdout = oldStdout
	out, _ := io.ReadAll(r)
	if bytes.Contains(out, []byte("\x1b[")) || bytes.Contains(out, []byte("\r")) {
		t.Fatalf("spinner output has escapes or CR: %q", out)
	}
	if string(out) != "done\n" {
		t.Fatalf("output = %q, want result line only", out)
	}
}
