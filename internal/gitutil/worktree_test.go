package gitutil

import (
	"os"
	"path/filepath"
	"testing"
)

// realPath resolves symlinks so comparisons work on macOS, where t.TempDir()
// hands back /var/... while git reports the underlying /private/var/... .
func realPath(t *testing.T, p string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatalf("EvalSymlinks(%q): %v", p, err)
	}
	return resolved
}

// newRepo builds a one-commit repo and returns its root.
func newRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitRun(t, dir, "init", "-b", "main")
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644)
	gitRun(t, dir, "add", "a.txt")
	gitRun(t, dir, "commit", "-m", "init")
	return dir
}

func TestMainRootFromMainWorktree(t *testing.T) {
	repo := newRepo(t)

	if got, want := realPath(t, MainRoot(repo)), realPath(t, repo); got != want {
		t.Fatalf("MainRoot(repo root) = %q, want %q", got, want)
	}

	sub := filepath.Join(repo, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if got, want := realPath(t, MainRoot(sub)), realPath(t, repo); got != want {
		t.Fatalf("MainRoot(subdir) = %q, want %q", got, want)
	}
}

func TestMainRootFromLinkedWorktreeReturnsMainClone(t *testing.T) {
	repo := newRepo(t)
	linked := filepath.Join(t.TempDir(), "feature")
	gitRun(t, repo, "worktree", "add", "-b", "feature", linked)

	// RepoRoot reports the linked worktree itself; MainRoot must see past it.
	root, err := RepoRoot(linked)
	if err != nil {
		t.Fatal(err)
	}
	if realPath(t, root) == realPath(t, repo) {
		t.Fatal("precondition failed: RepoRoot should return the linked worktree, not the clone")
	}
	if got, want := realPath(t, MainRoot(linked)), realPath(t, repo); got != want {
		t.Fatalf("MainRoot(linked worktree) = %q, want %q", got, want)
	}
}

// Running `worktree add <branch>` from inside a linked worktree must still
// nest the new worktree under the *repository* name, not under the name of
// the worktree we happened to be standing in.
func TestCreateBranchWorktreeFromLinkedWorktreeNestsUnderRepoName(t *testing.T) {
	repo := newRepo(t)
	base := t.TempDir()
	repoName := filepath.Base(repo)

	first, err := CreateBranchWorktree(repo, base, "first")
	if err != nil {
		t.Fatalf("creating first worktree: %v", err)
	}
	if want := filepath.Join(base, repoName, "first"); first.Path != want {
		t.Fatalf("first worktree at %q, want %q", first.Path, want)
	}

	// Now add a second worktree while standing in the first one.
	second, err := CreateBranchWorktree(first.Path, base, "second")
	if err != nil {
		t.Fatalf("creating second worktree: %v", err)
	}
	if want := filepath.Join(base, repoName, "second"); second.Path != want {
		t.Fatalf("second worktree at %q, want %q", second.Path, want)
	}
	if !second.Created {
		t.Fatal("second worktree reported as not created")
	}
	// It should still branch from the HEAD of the worktree we ran from.
	if got, want := RevParse(second.Path, "HEAD"), RevParse(first.Path, "HEAD"); got != want {
		t.Fatalf("second HEAD = %q, want first's HEAD %q", got, want)
	}
}
