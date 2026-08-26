package gitutil

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

func TestShortStatusCountsStagedModifiedUntracked(t *testing.T) {
	dir := t.TempDir()
	gitRun(t, dir, "init", "-b", "main")
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644)
	gitRun(t, dir, "add", "a.txt")
	gitRun(t, dir, "commit", "-m", "init")

	st, ok := ShortStatus(dir)
	if !ok {
		t.Fatal("ShortStatus not ok on a real repo")
	}
	if st.Branch != "main" {
		t.Fatalf("branch = %q, want main", st.Branch)
	}
	if !st.Clean() {
		t.Fatalf("fresh commit should be clean, got %+v", st)
	}

	// staged (new file added), modified (tracked file changed), untracked.
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("two\n"), 0o644)
	gitRun(t, dir, "add", "b.txt")
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("changed\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "c.txt"), []byte("three\n"), 0o644)

	st, _ = ShortStatus(dir)
	if st.Staged != 1 || st.Modified != 1 || st.Untracked != 1 {
		t.Fatalf("counts = staged %d modified %d untracked %d, want 1/1/1 (%+v)",
			st.Staged, st.Modified, st.Untracked, st)
	}
	if st.Clean() {
		t.Fatal("tree with changes reported clean")
	}
}

func TestShortStatusParsesAheadBehind(t *testing.T) {
	origin := t.TempDir()
	gitRun(t, origin, "init", "--bare", "-b", "main")

	dir := t.TempDir()
	gitRun(t, dir, "init", "-b", "main")
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644)
	gitRun(t, dir, "add", "a.txt")
	gitRun(t, dir, "commit", "-m", "init")
	gitRun(t, dir, "remote", "add", "origin", origin)
	gitRun(t, dir, "push", "-u", "origin", "main")

	// One unpushed commit => ahead 1.
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("two\n"), 0o644)
	gitRun(t, dir, "commit", "-am", "second")

	st, ok := ShortStatus(dir)
	if !ok {
		t.Fatal("not ok")
	}
	if st.Ahead != 1 || st.Behind != 0 {
		t.Fatalf("ahead/behind = %d/%d, want 1/0 (%+v)", st.Ahead, st.Behind, st)
	}
	if st.Upstream != "origin/main" {
		t.Fatalf("upstream = %q, want origin/main", st.Upstream)
	}
	// Ahead but no file changes: still clean. A conflated "dirty" flag would
	// get this wrong.
	if !st.Clean() {
		t.Fatalf("ahead-but-unmodified tree should be clean, got %+v", st)
	}
}

func TestShortStatusNotARepo(t *testing.T) {
	if _, ok := ShortStatus(t.TempDir()); ok {
		t.Fatal("expected ok=false outside a git repo")
	}
}

// A repo with no commits yet reports "## No commits yet on <branch>", which
// naive parsing turns into a branch named "No commits yet on main".
func TestShortStatusBranchBeforeFirstCommit(t *testing.T) {
	dir := t.TempDir()
	gitRun(t, dir, "init", "-b", "main")

	st, ok := ShortStatus(dir)
	if !ok {
		t.Fatal("not ok")
	}
	if st.Branch != "main" {
		t.Fatalf("branch = %q, want main", st.Branch)
	}
}
