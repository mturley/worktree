package gitutil

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// runIn runs git in dir with the user's identity, config and hooks scrubbed
// out (same env as internal/testgit), failing the test on error.
func runIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// commitFile writes a file and commits it.
func commitFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	runIn(t, dir, "add", name)
	runIn(t, dir, "commit", "-m", "add "+name)
}

// newRemoteRepo builds a repo on `main` with one commit, pushed to a bare
// `origin` so that main@{upstream} is origin/main. It returns the repo path
// and a run func that executes git in it and fails the test on error.
// (newRepo, in worktree_test.go, is the remote-less variant.)
func newRemoteRepo(t *testing.T) (repo string, run func(args ...string) string) {
	t.Helper()
	base := t.TempDir()
	repo = filepath.Join(base, "repo")
	bare := filepath.Join(base, "origin.git")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	runIn(t, base, "init", "--bare", "-b", "main", bare)
	runIn(t, repo, "init", "-b", "main")
	commitFile(t, repo, "a.txt", "one\n")
	runIn(t, repo, "remote", "add", "origin", bare)
	runIn(t, repo, "push", "-u", "origin", "main")
	return repo, func(args ...string) string {
		t.Helper()
		return runIn(t, repo, args...)
	}
}

func TestMainUpstreamResolvesConfiguredUpstream(t *testing.T) {
	repo, _ := newRemoteRepo(t)
	got, ok := MainUpstream(repo)
	if !ok || got != "origin/main" {
		t.Fatalf("MainUpstream = (%q, %v), want (origin/main, true)", got, ok)
	}
}

func TestMainUpstreamFallsBackToOriginHEAD(t *testing.T) {
	repo, run := newRemoteRepo(t)
	run("branch", "--unset-upstream", "main")
	run("remote", "set-head", "origin", "main")
	got, ok := MainUpstream(repo)
	if !ok || got != "origin/main" {
		t.Fatalf("MainUpstream = (%q, %v), want (origin/main, true)", got, ok)
	}
}

func TestMainUpstreamUnresolvable(t *testing.T) {
	repo := newRepo(t)
	if got, ok := MainUpstream(repo); ok || got != "" {
		t.Fatalf("MainUpstream = (%q, %v), want (\"\", false)", got, ok)
	}
}

func TestDefaultBranchNotMain(t *testing.T) {
	base := t.TempDir()
	repo := filepath.Join(base, "repo")
	bare := filepath.Join(base, "origin.git")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	runIn(t, base, "init", "--bare", "-b", "master", bare)
	runIn(t, repo, "init", "-b", "master")
	commitFile(t, repo, "a.txt", "one\n")
	runIn(t, repo, "remote", "add", "origin", bare)
	runIn(t, repo, "push", "-u", "origin", "master")
	runIn(t, repo, "remote", "set-head", "origin", "master")

	got, ok := MainUpstream(repo)
	if !ok || got != "origin/master" {
		t.Fatalf("MainUpstream = (%q, %v), want (origin/master, true)", got, ok)
	}
}

func TestTrackingBranch(t *testing.T) {
	repo, _ := newRemoteRepo(t)
	got, ok := TrackingBranch(repo)
	if !ok || got != "origin/main" {
		t.Fatalf("TrackingBranch = (%q, %v), want (origin/main, true)", got, ok)
	}
}

func TestTrackingBranchAbsentForUnpushedBranch(t *testing.T) {
	repo, run := newRemoteRepo(t)
	run("checkout", "-b", "feature")
	if got, ok := TrackingBranch(repo); ok {
		t.Fatalf("TrackingBranch = (%q, true), want false", got)
	}
}

func TestTrackingBranchDetachedHEAD(t *testing.T) {
	repo, run := newRemoteRepo(t)
	run("checkout", "--detach")
	if got, ok := TrackingBranch(repo); ok {
		t.Fatalf("TrackingBranch = (%q, true), want false", got)
	}
}

func TestMergeBase(t *testing.T) {
	repo, run := newRemoteRepo(t)
	base := run("rev-parse", "HEAD")
	run("checkout", "-b", "feature")
	commitFile(t, repo, "b.txt", "b\n")
	got, ok := MergeBase(repo, "origin/main")
	if !ok || got != base {
		t.Fatalf("MergeBase = (%q, %v), want (%q, true)", got, ok, base)
	}
}

func TestAheadBehind(t *testing.T) {
	repo, run := newRemoteRepo(t)
	run("checkout", "-b", "feature")
	commitFile(t, repo, "f1.txt", "1\n")
	commitFile(t, repo, "f2.txt", "2\n")

	// Advance origin/main by three commits from a second clone.
	otherBase := t.TempDir()
	other := filepath.Join(otherBase, "other")
	runIn(t, otherBase, "clone", run("config", "remote.origin.url"), other)
	for _, n := range []string{"m1.txt", "m2.txt", "m3.txt"} {
		commitFile(t, other, n, n)
	}
	runIn(t, other, "push", "origin", "main")
	run("fetch", "origin")

	ahead, behind, ok := AheadBehind(repo, "origin/main")
	if !ok || ahead != 2 || behind != 3 {
		t.Fatalf("AheadBehind = (%d, %d, %v), want (2, 3, true)", ahead, behind, ok)
	}
}

func TestRevSHA(t *testing.T) {
	repo, run := newRemoteRepo(t)
	want := run("rev-parse", "HEAD")
	if got, ok := RevSHA(repo, "HEAD"); !ok || got != want {
		t.Fatalf("RevSHA(HEAD) = (%q, %v), want (%q, true)", got, ok, want)
	}
	if got, ok := RevSHA(repo, "nope"); ok {
		t.Fatalf("RevSHA(nope) = (%q, true), want false", got)
	}
}

func TestRefsOnRepoWithNoCommits(t *testing.T) {
	dir := t.TempDir()
	runIn(t, dir, "init", "-b", "main")

	if got, ok := MainUpstream(dir); ok {
		t.Errorf("MainUpstream = (%q, true)", got)
	}
	if got, ok := TrackingBranch(dir); ok {
		t.Errorf("TrackingBranch = (%q, true)", got)
	}
	if got, ok := MergeBase(dir, "main"); ok {
		t.Errorf("MergeBase = (%q, true)", got)
	}
	if _, _, ok := AheadBehind(dir, "main"); ok {
		t.Error("AheadBehind ok on empty repo")
	}
	if got, ok := RevSHA(dir, "HEAD"); ok {
		t.Errorf("RevSHA = (%q, true)", got)
	}
}

func TestMergeBaseOf(t *testing.T) {
	repo, run := newRemoteRepo(t)
	m := run("rev-parse", "HEAD")
	run("checkout", "-b", "a")
	commitFile(t, repo, "a.txt", "a")
	run("checkout", "-b", "b", m)
	commitFile(t, repo, "b.txt", "b")

	got, ok := MergeBaseOf(repo, "a", "b")
	if !ok || got != m {
		t.Fatalf("MergeBaseOf(a, b) = %q, %v; want %q, true", got, ok, m)
	}
	if got, ok := MergeBaseOf(repo, "a", "no-such-rev"); ok || got != "" {
		t.Fatalf("unknown rev: got %q, %v; want \"\", false", got, ok)
	}
}
