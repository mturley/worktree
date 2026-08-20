package setup

import (
	"bytes"
	"strings"
	"testing"

	"github.com/mturley/watcher/credsetup"
	"github.com/mturley/worktree/internal/ui"
)

func TestPrompterImplementsCredsetupInterface(t *testing.T) {
	var _ credsetup.Prompter = Prompter{}
}

// TestPrompterInfoColorRouting verifies Info colors each message by the
// outcome it conveys — success green, failure (failed OR invalid) red, and
// progress/other lines plain — matching the wording credsetup.TestAndRepair
// emits. Interactive prompts (Confirm/PromptToken/PromptSlack) read from
// stdin and are left to manual smoke testing.
func TestPrompterInfoColorRouting(t *testing.T) {
	cases := []struct {
		msg  string
		want string // ui color wrapper the line must use
	}{
		{"GitHub: ok", ui.ColorGreen},
		{"GitHub: failed (bad credentials)", ui.ColorRed},
		{"GitHub: new token invalid (401)", ui.ColorRed},
		{"Testing GitHub credentials...", ""}, // plain — no color
	}
	for _, c := range cases {
		var buf bytes.Buffer
		p := Prompter{out: &buf}
		p.Info(c.msg)
		got := buf.String()
		if !strings.Contains(got, c.msg) {
			t.Fatalf("Info(%q) output missing the message: %q", c.msg, got)
		}
		if c.want == "" {
			// plain: must NOT be wrapped in green or red.
			if strings.Contains(got, ui.ColorGreen) || strings.Contains(got, ui.ColorRed) {
				t.Fatalf("Info(%q) should be plain, got colored: %q", c.msg, got)
			}
			continue
		}
		if !strings.Contains(got, c.want) {
			t.Fatalf("Info(%q): want color %q, got %q", c.msg, c.want, got)
		}
	}
}
