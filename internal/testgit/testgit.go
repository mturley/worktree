// Package testgit builds throwaway git repositories for tests.
//
// It exists because resources.Add refuses any path that is not a linked git
// worktree, so tests that track resources need a path git itself agrees is
// one — a bare t.TempDir() no longer qualifies.
package testgit

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Worktree creates a repo with one commit plus a linked worktree of it, and
// returns the linked worktree's path. Both live under t.TempDir(), so the test
// framework cleans them up. Each call returns a copy of one template (see
// Template), so it runs no git commands after the first.
func Worktree(t *testing.T) string {
	t.Helper()
	return filepath.Join(Template(t, "worktree", buildWorktree), "wt")
}

func buildWorktree(t *testing.T, base string) {
	t.Helper()
	repo := filepath.Join(base, "repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		// Keep the user's real git identity and hooks out of it.
		cmd.Env = append(os.Environ(),
			"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	run(repo, "init", "--initial-branch=main", ".")
	if err := os.WriteFile(filepath.Join(repo, "f"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(repo, "add", "f")
	run(repo, "commit", "-m", "init")
	run(repo, "worktree", "add", "-b", "feature", filepath.Join(base, "wt"))
}
