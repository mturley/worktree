package cmux

import (
	"os/exec"
	"strings"
	"testing"
)

func TestNotifyArgs(t *testing.T) {
	orig := cmuxCmd
	t.Cleanup(func() { cmuxCmd = orig })
	var got []string
	cmuxCmd = func(args ...string) *exec.Cmd { got = args; return exec.Command("true") }

	if err := Notify(NotifyOptions{Title: "T", Subtitle: "S", Body: "B", Workspace: "WS-1"}); err != nil {
		t.Fatal(err)
	}
	want := []string{"notify", "--title", "T", "--subtitle", "S", "--body", "B", "--workspace", "WS-1"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("args = %q, want %q", got, want)
	}

	if err := Notify(NotifyOptions{Title: "T"}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, "|") != "notify|--title|T" {
		t.Fatalf("empty fields must be omitted, got %q", got)
	}
}

func TestNotifyError(t *testing.T) {
	orig := cmuxCmd
	t.Cleanup(func() { cmuxCmd = orig })
	cmuxCmd = func(args ...string) *exec.Cmd { return exec.Command("sh", "-c", "echo boom >&2; exit 1") }
	err := Notify(NotifyOptions{Title: "T"})
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v, want it to carry cmux's output", err)
	}
}
