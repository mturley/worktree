package cmd

import (
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/mturley/worktree/internal/registry"
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

func TestDetailPathForToplevel_TrackedWorktree(t *testing.T) {
	dir := t.TempDir()
	entries := []registry.Entry{{Path: dir, Repo: "r", RepoRoot: "/r", Branch: "b"}}
	got := detailPathForToplevel(dir, entries)
	want := "/worktree/" + url.PathEscape(dir)
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestDetailPathForToplevel_SymlinkCanonicalizes(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unsupported in this environment: %v", err)
	}

	// Registry row was recorded via the symlinked path (as created), but the
	// git toplevel discovery.IsInsideWorktree returns is the resolved real path.
	entries := []registry.Entry{{Path: link, Repo: "r", RepoRoot: "/r", Branch: "b"}}
	got := detailPathForToplevel(real, entries)
	want := "/worktree/" + url.PathEscape(link)
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestDetailPathForToplevel_NoMatchingRegistryRow(t *testing.T) {
	dir := t.TempDir()
	entries := []registry.Entry{{Path: filepath.Join(dir, "other"), Repo: "r", RepoRoot: "/r", Branch: "b"}}
	if got := detailPathForToplevel(dir, entries); got != "/" {
		t.Fatalf("got %q, want /", got)
	}
}

func TestDetailPathForToplevel_EmptyEntries(t *testing.T) {
	dir := t.TempDir()
	if got := detailPathForToplevel(dir, nil); got != "/" {
		t.Fatalf("got %q, want /", got)
	}
}
