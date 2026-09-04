package cmd

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

func TestBindIsLoopback(t *testing.T) {
	tests := []struct {
		host string
		want bool
	}{
		{"127.0.0.1", true},
		{"localhost", true},
		{"::1", true},
		{"127.0.0.53", true},
		{"0.0.0.0", false},
		{"", false},
		{"::", false},
		{"192.168.86.21", false},
		{"my-mac.local", false},
	}
	for _, tc := range tests {
		if got := bindIsLoopback(tc.host); got != tc.want {
			t.Errorf("bindIsLoopback(%q) = %v, want %v", tc.host, got, tc.want)
		}
	}
}

func TestConfirmBind_LoopbackNeitherWarnsNorPrompts(t *testing.T) {
	var out bytes.Buffer
	// Empty stdin: a prompt here would fail on EOF, proving none happened.
	if err := confirmBind("127.0.0.1", false, true, strings.NewReader(""), &out); err != nil {
		t.Fatalf("confirmBind() = %v, want nil", err)
	}
	if out.Len() != 0 {
		t.Fatalf("confirmBind() wrote %q, want no output for a loopback bind", out.String())
	}
}

func TestConfirmBind_NonLoopbackAcceptedOnYes(t *testing.T) {
	var out bytes.Buffer
	if err := confirmBind("0.0.0.0", false, true, strings.NewReader("y\n"), &out); err != nil {
		t.Fatalf("confirmBind() = %v, want nil", err)
	}
	if !strings.Contains(out.String(), "WARNING") {
		t.Fatalf("confirmBind() output %q, want it to contain a WARNING", out.String())
	}
}

func TestConfirmBind_NonLoopbackAbortsOnNo(t *testing.T) {
	var out bytes.Buffer
	if err := confirmBind("0.0.0.0", false, true, strings.NewReader("n\n"), &out); err == nil {
		t.Fatal("confirmBind() = nil, want an error when the user answers no")
	}
}

func TestConfirmBind_NonLoopbackDefaultsToNoOnEmptyAnswer(t *testing.T) {
	var out bytes.Buffer
	if err := confirmBind("0.0.0.0", false, true, strings.NewReader("\n"), &out); err == nil {
		t.Fatal("confirmBind() = nil, want an error when the user just presses enter")
	}
}

func TestConfirmBind_AssumeYesSkipsPromptButStillWarns(t *testing.T) {
	var out bytes.Buffer
	if err := confirmBind("0.0.0.0", true, true, strings.NewReader(""), &out); err != nil {
		t.Fatalf("confirmBind() = %v, want nil", err)
	}
	if !strings.Contains(out.String(), "WARNING") {
		t.Fatalf("confirmBind() output %q, want it to still contain a WARNING", out.String())
	}
}

func TestConfirmBind_NonInteractiveWithoutYesIsRefused(t *testing.T) {
	var out bytes.Buffer
	err := confirmBind("0.0.0.0", false, false, strings.NewReader("y\n"), &out)
	if err == nil {
		t.Fatal("confirmBind() = nil, want an error when stdin is not a terminal")
	}
	if !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("confirmBind() error = %q, want it to mention --yes", err)
	}
}

// /dev/null is a character device but not a terminal. Detecting it as one
// made `worktree ui --bind 0.0.0.0 </dev/null` prompt into the void and then
// report "declined" instead of telling the user to pass --yes.
func TestIsTerminalFile_DevNullIsNotATerminal(t *testing.T) {
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatalf("opening %s: %v", os.DevNull, err)
	}
	defer f.Close()
	if isTerminalFile(f) {
		t.Fatalf("isTerminalFile(%s) = true, want false", os.DevNull)
	}
}
