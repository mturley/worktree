package gitutil

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func branchRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-b", "main")
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644)
	run("add", "a.txt")
	run("commit", "-m", "init")
	return dir
}

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

func TestDeleteBranchMerged(t *testing.T) {
	dir := branchRepo(t)
	gitIn(t, dir, "branch", "feature")

	if err := DeleteBranch(dir, "feature", false); err != nil {
		t.Fatalf("deleting a merged branch should succeed, got %v", err)
	}
	out, _ := exec.Command("git", "-C", dir, "branch", "--list", "feature").Output()
	if len(out) != 0 {
		t.Fatalf("branch still present: %s", out)
	}
}

// An unmerged branch is the COMMON case for a worktree: the PR has not landed
// yet. git refuses it with -d, and that refusal must arrive as ErrNeedsForce so
// callers can escalate exactly as they do for a worktree directory.
func TestDeleteBranchUnmergedNeedsForce(t *testing.T) {
	dir := branchRepo(t)
	gitIn(t, dir, "checkout", "-b", "feature")
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("two\n"), 0o644)
	gitIn(t, dir, "add", "b.txt")
	gitIn(t, dir, "commit", "-m", "unmerged work")
	gitIn(t, dir, "checkout", "main")

	err := DeleteBranch(dir, "feature", false)
	var needsForce *ErrNeedsForce
	if !errors.As(err, &needsForce) {
		t.Fatalf("err = %v, want *ErrNeedsForce", err)
	}
	if needsForce.GitOutput == "" {
		t.Fatal("ErrNeedsForce carries no git output to show the user")
	}
}

func TestDeleteBranchForcedDeletesUnmerged(t *testing.T) {
	dir := branchRepo(t)
	gitIn(t, dir, "checkout", "-b", "feature")
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("two\n"), 0o644)
	gitIn(t, dir, "add", "b.txt")
	gitIn(t, dir, "commit", "-m", "unmerged work")
	gitIn(t, dir, "checkout", "main")

	if err := DeleteBranch(dir, "feature", true); err != nil {
		t.Fatalf("forced delete failed: %v", err)
	}
	out, _ := exec.Command("git", "-C", dir, "branch", "--list", "feature").Output()
	if len(out) != 0 {
		t.Fatalf("branch still present after forced delete: %s", out)
	}
}

func TestDeleteBranchMissingIsAnError(t *testing.T) {
	dir := branchRepo(t)
	err := DeleteBranch(dir, "nope", false)
	if err == nil {
		t.Fatal("deleting a non-existent branch should error")
	}
	var needsForce *ErrNeedsForce
	if errors.As(err, &needsForce) {
		t.Fatalf("a missing branch must not be wrapped as ErrNeedsForce (forcing would not help): %v", err)
	}
}
