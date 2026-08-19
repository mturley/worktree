package cmd

import (
	"runtime"
	"testing"
)

func TestBrowserOpenCommand_Cmux(t *testing.T) {
	t.Setenv("CMUX_WORKSPACE_ID", "ws-123")
	got := browserOpenCommand("http://127.0.0.1:8475")
	want := []string{"cmux", "open", "http://127.0.0.1:8475"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestBrowserOpenCommand_NotCmux(t *testing.T) {
	t.Setenv("CMUX_WORKSPACE_ID", "")
	got := browserOpenCommand("http://127.0.0.1:8475")
	switch runtime.GOOS {
	case "darwin":
		if len(got) != 2 || got[0] != "open" {
			t.Fatalf("darwin: got %v, want [open <url>]", got)
		}
	case "linux":
		if len(got) != 2 || got[0] != "xdg-open" {
			t.Fatalf("linux: got %v, want [xdg-open <url>]", got)
		}
	default:
		if got != nil {
			t.Fatalf("unsupported platform: got %v, want nil", got)
		}
	}
}
