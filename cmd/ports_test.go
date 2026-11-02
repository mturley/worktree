package cmd

import (
	"context"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/listeners"
)

func TestPortsListeningUsesSnapshot(t *testing.T) {
	seedReadFixture(t)
	old := listenersRunner
	listenersRunner = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return nil, nil // lsof finds nothing
	}
	t.Cleanup(func() { listenersRunner = old })

	out, err := runCLI(t, "ports", "--listening", "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var snap listeners.Snapshot
	decodeEnvelope(t, out, "listeners", &snap)
	if !snap.Enabled {
		t.Fatalf("snapshot = %+v", snap)
	}
	var allocs []map[string]any
	decodeEnvelope(t, out, "allocations", &allocs)

	text, err := runCLI(t, "ports", "--listening")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, "\x1b") {
		t.Fatalf("ANSI in piped output: %q", text)
	}
}

func TestPortsListeningAttributesListener(t *testing.T) {
	live, _ := seedReadFixture(t)
	old := listenersRunner
	listenersRunner = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		for _, a := range args {
			if a == "cwd" {
				return []byte("p4242\nn" + listeners.Canonical(live) + "\n"), nil
			}
		}
		return []byte("p4242\ncnode\nn*:59999\n"), nil
	}
	t.Cleanup(func() { listenersRunner = old })

	text, err := runCLI(t, "ports", "--listening")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, ":59999  node (4242)  "+live) {
		t.Fatalf("no attributed listener line:\n%s", text)
	}
}
