package worktreenew

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/github"
	"github.com/mturley/worktree/internal/gitutil"
)

func TestDefaultBranchForJiraInputs(t *testing.T) {
	for _, input := range []string{"PROJ-7", "https://x.atlassian.net/browse/PROJ-7"} {
		got, err := DefaultBranch(config.Config{}, input, "")
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", input, err)
		}
		if got != "proj-7" {
			t.Fatalf("%s: default = %q, want proj-7", input, got)
		}
	}
}

// A plain branch name is already the branch, so there is nothing to ask.
func TestDefaultBranchForPlainBranchIsEmpty(t *testing.T) {
	got, err := DefaultBranch(config.Config{}, "my-feature", "")
	if err != nil || got != "" {
		t.Fatalf("default = %q, %v; want empty", got, err)
	}
}

func TestDefaultBranchForPR(t *testing.T) {
	stubPR(t, gitutil.PRWorktreeResult{})
	got, err := DefaultBranch(config.Config{}, "https://github.com/owner/repo/pull/1", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != testPRBranch {
		t.Fatalf("default = %q, want %q", got, testPRBranch)
	}
}

func TestDefaultBranchForPRRefusedWhileGitHubWatcherOff(t *testing.T) {
	origFetch := fetchPRInfo
	fetchPRInfo = func(string, string, int) (*github.PRInfo, error) {
		t.Fatal("GitHub was contacted while its watcher is off")
		return nil, nil
	}
	t.Cleanup(func() { fetchPRInfo = origFetch })

	cfg := config.Config{}
	cfg.Watchers.SetEnabled(config.ServiceGitHub, false)
	_, err := DefaultBranch(cfg, "https://github.com/owner/repo/pull/1", "")
	if !errors.Is(err, ErrGitHubWatcherDisabled) {
		t.Fatalf("err = %v, want ErrGitHubWatcherDisabled", err)
	}
}

func TestRunJiraUsesChosenBranch(t *testing.T) {
	repo := newRepo(t)
	base := t.TempDir()

	res := Run(nil, config.Config{WorktreesBase: base},
		Options{Input: "PROJ-7", RepoRoot: repo, Branch: "proj-7-tidy-up"}, nil)

	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}
	if res.Branch != "proj-7-tidy-up" {
		t.Fatalf("branch = %q, want proj-7-tidy-up", res.Branch)
	}
	if want := filepath.Join(base, filepath.Base(repo), "proj-7-tidy-up"); res.Path != want {
		t.Fatalf("path = %q, want %q", res.Path, want)
	}
}

// The chosen branch reaches git; the PR's directory name does not change.
func TestRunPRPassesChosenBranch(t *testing.T) {
	repo := prRepo(t, "")
	base := t.TempDir()
	stubPR(t, gitutil.PRWorktreeResult{})
	var gotBranch string
	inner := createPRWorktree
	createPRWorktree = func(repoRoot, b, remote string, n int, slug, branch string) (gitutil.PRWorktreeResult, error) {
		gotBranch = branch
		return inner(repoRoot, b, remote, n, slug, branch)
	}

	Run(nil, config.Config{WorktreesBase: base},
		Options{Input: "https://github.com/owner/repo/pull/1", RepoRoot: repo, Branch: "mine/pr-1"}, nil)

	if gotBranch != "mine/pr-1" {
		t.Fatalf("branch passed to git = %q, want mine/pr-1", gotBranch)
	}

	// With no choice made, the branch is named after the PR's head branch.
	Run(nil, config.Config{WorktreesBase: base},
		Options{Input: "https://github.com/owner/repo/pull/1", RepoRoot: repo}, nil)

	if gotBranch != testPRBranch {
		t.Fatalf("default branch passed to git = %q, want %q", gotBranch, testPRBranch)
	}
}

// Input is the branch for a plain branch name; an override would be ambiguous.
func TestRunPlainBranchIgnoresOverride(t *testing.T) {
	repo := newRepo(t)
	res := Run(nil, config.Config{WorktreesBase: t.TempDir()},
		Options{Input: "my-feature", RepoRoot: repo, Branch: "other"}, nil)
	if res.Err != nil || res.Branch != "my-feature" {
		t.Fatalf("branch = %q, err = %v; want my-feature", res.Branch, res.Err)
	}
}

func TestRunRejectsInvalidChosenBranch(t *testing.T) {
	repo := newRepo(t)
	res := Run(nil, config.Config{WorktreesBase: t.TempDir()},
		Options{Input: "PROJ-7", RepoRoot: repo, Branch: "bad..name"}, nil)
	if res.Err == nil {
		t.Fatal("expected an error for an invalid branch name")
	}
	if got := statusOf(res, StepCreateWorktree); got != StatusPending {
		t.Fatalf("create_worktree = %q, want pending (never reached)", got)
	}
}
