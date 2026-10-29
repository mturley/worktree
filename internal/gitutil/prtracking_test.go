package gitutil

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// prTrackingRepo builds bare repos <base>/owner/repo.git (the PR's base, with
// a "same-repo" branch) and <base>/someone/repo.git (a fork, with a "fork"
// branch), plus a clone of the base whose origin points at it, checked out on
// a local review branch. It returns the clone and the base dir.
func prTrackingRepo(t *testing.T) (clone, base string) {
	t.Helper()
	base = t.TempDir()
	clone = filepath.Join(base, "clone")
	if err := os.MkdirAll(clone, 0o755); err != nil {
		t.Fatal(err)
	}
	baseRepo := filepath.Join(base, "owner", "repo.git")
	forkRepo := filepath.Join(base, "someone", "repo.git")
	runIn(t, base, "init", "--bare", "-b", "main", baseRepo)
	runIn(t, base, "init", "--bare", "-b", "main", forkRepo)
	runIn(t, clone, "init", "-b", "main")
	commitFile(t, clone, "a.txt", "one\n")
	runIn(t, clone, "remote", "add", "origin", baseRepo)
	runIn(t, clone, "push", "origin", "main", "main:same-repo")
	runIn(t, clone, "push", forkRepo, "main:fork")
	runIn(t, clone, "checkout", "-b", "review/pr-7")
	return clone, base
}

func TestSetPRTrackingSameRepoTracksTheHeadBranch(t *testing.T) {
	t.Parallel()
	clone, _ := prTrackingRepo(t)

	err := SetPRTracking(clone, "review/pr-7", PRHead{
		Number: 7, BaseRemote: "origin", Owner: "owner", Repo: "repo", Ref: "same-repo",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := TrackingBranch(clone); !ok || got != "origin/same-repo" {
		t.Fatalf("TrackingBranch = %q, %v; want origin/same-repo", got, ok)
	}
	if remotes := runIn(t, clone, "remote"); remotes != "origin" {
		t.Fatalf("remotes = %q; want only origin", remotes)
	}
	if n, ok := TrackedPRNumber(clone); !ok || n != 7 {
		t.Fatalf("TrackedPRNumber = %d, %v; want 7, true", n, ok)
	}
}

func TestSetPRTrackingForkAddsARemoteForIt(t *testing.T) {
	t.Parallel()
	clone, base := prTrackingRepo(t)

	err := SetPRTracking(clone, "review/pr-7", PRHead{
		Number: 7, BaseRemote: "origin", Owner: "someone", Repo: "repo", Ref: "fork",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := TrackingBranch(clone); !ok || got != "someone/fork" {
		t.Fatalf("TrackingBranch = %q, %v; want someone/fork", got, ok)
	}
	if got, want := RemoteURL(clone, "someone"), filepath.Join(base, "someone", "repo.git"); got != want {
		t.Fatalf("remote someone = %q; want %q", got, want)
	}
	if n, ok := TrackedPRNumber(clone); !ok || n != 7 {
		t.Fatalf("TrackedPRNumber = %d, %v; want 7, true", n, ok)
	}

	// A second run (re-creating the same PR's worktree) reuses the remote.
	if err := SetPRTracking(clone, "review/pr-7", PRHead{
		Number: 7, BaseRemote: "origin", Owner: "someone", Repo: "repo", Ref: "fork",
	}); err != nil {
		t.Fatalf("second run: %v", err)
	}
}

func TestSetPRTrackingDeletedForkFallsBackToThePullRef(t *testing.T) {
	t.Parallel()
	clone, _ := prTrackingRepo(t)

	if err := SetPRTracking(clone, "review/pr-7", PRHead{Number: 7, BaseRemote: "origin", Ref: "gone"}); err != nil {
		t.Fatal(err)
	}
	if got := runIn(t, clone, "config", "branch.review/pr-7.merge"); got != "refs/pull/7/head" {
		t.Fatalf("merge = %q; want refs/pull/7/head", got)
	}
	if got := runIn(t, clone, "config", "branch.review/pr-7.remote"); got != "origin" {
		t.Fatalf("remote = %q; want origin", got)
	}
	if n, ok := TrackedPRNumber(clone); !ok || n != 7 {
		t.Fatalf("TrackedPRNumber = %d, %v; want 7, true", n, ok)
	}
}

func TestEnsureRemoteForRepoRefusesATakenName(t *testing.T) {
	t.Parallel()
	clone, _ := prTrackingRepo(t)
	runIn(t, clone, "remote", "add", "someone", "https://example.com/someone/other.git")

	_, err := EnsureRemoteForRepo(clone, "someone", "repo", "origin")
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("err = %v; want a remote-name collision", err)
	}
}

func TestSiblingRepoURL(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ in, want string }{
		{"https://github.com/owner/repo.git", "https://github.com/fork/repo2.git"},
		{"https://github.com/owner/repo", "https://github.com/fork/repo2"},
		{"git@github.com:owner/repo.git", "git@github.com:fork/repo2.git"},
		{"ssh://git@github.com/owner/repo.git", "ssh://git@github.com/fork/repo2.git"},
		{"repo", ""},
		{"", ""},
	} {
		if got := siblingRepoURL(tc.in, "fork", "repo2"); got != tc.want {
			t.Errorf("siblingRepoURL(%q) = %q; want %q", tc.in, got, tc.want)
		}
	}
}
