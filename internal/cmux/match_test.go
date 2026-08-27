package cmux

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDisplayTitlePrefersTitle(t *testing.T) {
	// cmux leaves custom_title null on workspaces it titles itself
	// (e.g. "◐ handler-ratelimits"), so Title is the primary source.
	cases := []struct {
		name string
		w    Workspace
		want string
	}{
		{"title wins", Workspace{Ref: "workspace:1", Title: "T", CustomTitle: "C"}, "T"},
		{"custom title fallback", Workspace{Ref: "workspace:1", CustomTitle: "C"}, "C"},
		{"ref last resort", Workspace{Ref: "workspace:1"}, "workspace:1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.w.DisplayTitle(); got != tc.want {
				t.Fatalf("DisplayTitle() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestMatchResolvesSymlinks(t *testing.T) {
	// The bug this fixes: FindByDirectory compared raw strings, so a
	// worktree reached through a symlink never matched its workspace.
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	ws := []Workspace{{Ref: "workspace:1", CurrentDirectory: link}}
	got := Match(ws, []string{real})

	if len(got[real]) != 1 || got[real][0].Ref != "workspace:1" {
		t.Fatalf("Match() = %#v, want workspace:1 under %q", got, real)
	}
}

func TestMatchKeysByRequestedPathNotResolved(t *testing.T) {
	// Callers look up by the path they passed in. Keying by the resolved
	// path would make every lookup miss on a symlinked worktree.
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	ws := []Workspace{{Ref: "workspace:1", CurrentDirectory: real}}
	got := Match(ws, []string{link})

	if len(got[link]) != 1 {
		t.Fatalf("Match() should key by the requested path %q, got %#v", link, got)
	}
}

func TestMatchMultipleWorkspacesOnOnePath(t *testing.T) {
	dir := t.TempDir()
	ws := []Workspace{
		{Ref: "workspace:1", CurrentDirectory: dir},
		{Ref: "workspace:2", CurrentDirectory: dir},
	}
	got := Match(ws, []string{dir})
	if len(got[dir]) != 2 {
		t.Fatalf("want 2 matches, got %d", len(got[dir]))
	}
}

func TestMatchNoMatchIsAbsentNotEmpty(t *testing.T) {
	dir := t.TempDir()
	got := Match([]Workspace{{Ref: "workspace:1", CurrentDirectory: t.TempDir()}}, []string{dir})
	if _, ok := got[dir]; ok {
		t.Fatalf("unmatched path should be absent from the map, got %#v", got)
	}
}

func TestIsAvailableFollowsSocketEnv(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "")
	if IsAvailable() {
		t.Fatal("IsAvailable() = true with no socket path")
	}
	t.Setenv("CMUX_SOCKET_PATH", "/tmp/cmux.sock")
	if !IsAvailable() {
		t.Fatal("IsAvailable() = false with a socket path set")
	}
}
