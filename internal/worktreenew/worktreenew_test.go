package worktreenew

import (
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/mturley/worktree/internal/config"
)

// newRepo makes a temp git repo with one commit, and returns its root.
func newRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.email", "t@example.com")
	run("config", "user.name", "T")
	run("commit", "--allow-empty", "-m", "init")
	return dir
}

func TestRunCreatesBranchWorktree(t *testing.T) {
	repo := newRepo(t)
	base := t.TempDir()
	cfg := config.Config{WorktreesBase: base}

	res := Run(nil, cfg, Options{Input: "my-feature", RepoRoot: repo}, nil)

	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}
	if res.Confirm != nil {
		t.Fatalf("unexpected confirmation: %#v", res.Confirm)
	}
	if res.Branch != "my-feature" {
		t.Fatalf("branch = %q, want my-feature", res.Branch)
	}
	if got := statusOf(res, StepCreateWorktree); got != StatusDone {
		t.Fatalf("create_worktree = %q, want done", got)
	}
}

func TestRunReplayIsSkippedNotFailed(t *testing.T) {
	// Statelessness depends on this: granting a confirmation re-POSTs the
	// whole request, so a second run over finished work must not report
	// failure.
	repo := newRepo(t)
	cfg := config.Config{WorktreesBase: t.TempDir()}
	opts := Options{Input: "my-feature", RepoRoot: repo}

	Run(nil, cfg, opts, nil)
	res := Run(nil, cfg, opts, nil)

	if res.Err != nil {
		t.Fatalf("replay errored: %v", res.Err)
	}
	if got := statusOf(res, StepCreateWorktree); got != StatusSkipped {
		t.Fatalf("replayed create_worktree = %q, want skipped", got)
	}
}

func TestRunRejectsUnknownRepoRoot(t *testing.T) {
	cfg := config.Config{WorktreesBase: t.TempDir()}
	res := Run(nil, cfg, Options{Input: "x", RepoRoot: filepath.Join(t.TempDir(), "nope")}, nil)
	if res.Err == nil {
		t.Fatal("want an error for a repo root that does not exist")
	}
}

func TestRunObserverSeesEveryStep(t *testing.T) {
	repo := newRepo(t)
	cfg := config.Config{WorktreesBase: t.TempDir()}

	var seen []StepKey
	Run(nil, cfg, Options{Input: "my-feature", RepoRoot: repo}, func(s Step) {
		seen = append(seen, s.Key)
	})

	if len(seen) == 0 {
		t.Fatal("observer never called")
	}
	if seen[0] != StepPull {
		t.Fatalf("first observed step = %q, want pull", seen[0])
	}
}

func statusOf(r Result, k StepKey) Status {
	for _, s := range r.Steps {
		if s.Key == k {
			return s.Status
		}
	}
	return ""
}
