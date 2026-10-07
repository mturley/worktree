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

// worktree ui runs inside a cmux pane, so it inherits that pane's
// CMUX_SURFACE_ID. The cmux CLI targets the caller's surface from it, and a
// surface resolves globally, overriding --workspace: every notification then
// landed (and clicked through to) the ui's own workspace. A targeted
// notification must not carry the caller's surface.
func TestNotifyTargetedDropsCallerSurface(t *testing.T) {
	t.Setenv("CMUX_SURFACE_ID", "CALLER-SURFACE")
	t.Setenv("CMUX_SOCKET_PATH", "/tmp/cmux.sock")
	orig := cmuxCmd
	t.Cleanup(func() { cmuxCmd = orig })
	var ran *exec.Cmd
	cmuxCmd = func(args ...string) *exec.Cmd { ran = exec.Command("true"); return ran }

	if err := Notify(NotifyOptions{Title: "T", Workspace: "WS-1"}); err != nil {
		t.Fatal(err)
	}
	if ran.Env == nil {
		t.Fatal("targeted notify inherited the whole environment, including CMUX_SURFACE_ID")
	}
	if envHas(ran.Env, "CMUX_SURFACE_ID") {
		t.Fatal("targeted notify still carries CMUX_SURFACE_ID")
	}
	if !envHas(ran.Env, "CMUX_SOCKET_PATH") {
		t.Fatal("the rest of the environment (CMUX_SOCKET_PATH) must be kept")
	}
}

// An untargeted notification keeps the caller's surface: landing on the ui's
// own workspace is the intended fallback there.
func TestNotifyUntargetedKeepsEnvironment(t *testing.T) {
	t.Setenv("CMUX_SURFACE_ID", "CALLER-SURFACE")
	orig := cmuxCmd
	t.Cleanup(func() { cmuxCmd = orig })
	var ran *exec.Cmd
	cmuxCmd = func(args ...string) *exec.Cmd { ran = exec.Command("true"); return ran }
	if err := Notify(NotifyOptions{Title: "T"}); err != nil {
		t.Fatal(err)
	}
	if ran.Env != nil {
		t.Fatalf("untargeted notify should inherit the environment, got %d vars", len(ran.Env))
	}
}

func envHas(env []string, key string) bool {
	for _, kv := range env {
		if strings.HasPrefix(kv, key+"=") {
			return true
		}
	}
	return false
}
