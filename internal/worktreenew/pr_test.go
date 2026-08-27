package worktreenew

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/github"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/resources"
)

func TestParsePRInputFromURL(t *testing.T) {
	got, err := parsePRInput("https://github.com/owner/repo/pull/42", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got == nil || got.Owner != "owner" || got.Repo != "repo" || got.Number != 42 {
		t.Fatalf("= %#v, want owner/repo#42", got)
	}
}

func TestParsePRInputNonPRIsNil(t *testing.T) {
	got, err := parsePRInput("my-branch", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		t.Fatalf("= %#v, want nil for a branch name", got)
	}
}

func TestParsePRInputBareNumberNeedsARepo(t *testing.T) {
	// The web UI passes an explicitly chosen repo; without one a bare number
	// is unresolvable and must say so rather than guessing.
	if _, err := parsePRInput("42", ""); err == nil {
		t.Fatal("want an error for a bare PR number with no repo")
	}
}

func TestConfirmReuseBranchStopsTheRun(t *testing.T) {
	// A pending confirmation must stop the run: later steps stay pending so
	// the stepper can grey them rather than claiming they were skipped.
	r := &runner{}
	res := Result{Steps: r.finish(), Confirm: &Confirm{Key: ConfirmReuseBranch, Branch: "b"}}

	if statusOf(res, StepAllocatePorts) != StatusPending {
		t.Fatalf("allocate_ports = %q, want pending while a confirmation is open",
			statusOf(res, StepAllocatePorts))
	}
}

func TestConfirmKeysAreDistinct(t *testing.T) {
	// Both questions arise inside create_worktree, which is why ConfirmKey is
	// its own type rather than a StepKey.
	if ConfirmReuseBranch == ConfirmResetToPR {
		t.Fatal("confirm keys must be distinguishable")
	}
}

// --- runPR branch logic, exercised through the test seams -------------------
//
// github.FetchPRByRepo shells out to `gh` and CreatePRWorktree fetches from a
// real remote, so both are replaced here. Everything downstream of them — the
// confirmation state machine, the fallthrough, SetPRTracking, finalize — is
// the real code.

// prRepo makes a temp repo with a remote pointing at owner/repo and a branch
// named branchName that already exists (simulating a leftover review branch).
func prRepo(t *testing.T, branchName string) string {
	t.Helper()
	dir := newRepo(t)
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("remote", "add", "origin", "https://github.com/owner/repo.git")
	if branchName != "" {
		run("branch", branchName)
	}
	return dir
}

// stubPR points the seams at fixed answers for the duration of a test.
func stubPR(t *testing.T, res gitutil.PRWorktreeResult) {
	t.Helper()
	origFetch, origCreate := fetchPRInfo, createPRWorktree
	fetchPRInfo = func(owner, repo string, number int) (*github.PRInfo, error) {
		return &github.PRInfo{
			Number: number, Title: "Some Title", HeadRef: "feature",
			URL: "https://github.com/owner/repo/pull/1",
		}, nil
	}
	createPRWorktree = func(repoRoot, base, remote string, n int, headRef, slug string) (gitutil.PRWorktreeResult, error) {
		return res, nil
	}
	t.Cleanup(func() { fetchPRInfo, createPRWorktree = origFetch, origCreate })
}

const testPRBranch = "review/pr-1-some-title"

func TestRunPRAsksBeforeReusingABranch(t *testing.T) {
	repo := prRepo(t, testPRBranch)
	base := t.TempDir()
	stubPR(t, gitutil.PRWorktreeResult{
		CreateResult: gitutil.CreateResult{Path: filepath.Join(base, "pr-1"), Branch: testPRBranch},
		Status:       gitutil.PRWorktreeBranchExists,
		LocalHead:    "aaa", RemoteHead: "bbb", FetchRef: "refs/pr-review/1",
	})

	res := Run(nil, config.Config{WorktreesBase: base},
		Options{Input: "https://github.com/owner/repo/pull/1", RepoRoot: repo}, nil)

	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}
	if res.Confirm == nil || res.Confirm.Key != ConfirmReuseBranch {
		t.Fatalf("confirm = %#v, want ConfirmReuseBranch", res.Confirm)
	}
	if got := statusOf(res, StepAllocatePorts); got != StatusPending {
		t.Fatalf("allocate_ports = %q, want pending while a confirmation is open", got)
	}
}

// TestRunPRReusedBranchBehindStillAsksToReset pins the fallthrough: granting
// ReuseBranch must not skip the sync check. `fallthrough` in a value switch is
// easy to get subtly wrong, and getting it wrong would silently hand back a
// worktree stuck at an old commit.
func TestRunPRReusedBranchBehindStillAsksToReset(t *testing.T) {
	repo := prRepo(t, testPRBranch)
	base := t.TempDir()
	wtPath := filepath.Join(base, "pr-1")
	stubPR(t, gitutil.PRWorktreeResult{
		CreateResult: gitutil.CreateResult{Path: wtPath, Branch: testPRBranch},
		Status:       gitutil.PRWorktreeBranchExists,
		LocalHead:    "aaa", RemoteHead: "bbb", FetchRef: "refs/pr-review/1",
	})

	res := Run(nil, config.Config{WorktreesBase: base},
		Options{Input: "https://github.com/owner/repo/pull/1", RepoRoot: repo, ReuseBranch: true}, nil)

	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}
	if res.Confirm == nil || res.Confirm.Key != ConfirmResetToPR {
		t.Fatalf("confirm = %#v, want ConfirmResetToPR (did the fallthrough run?)", res.Confirm)
	}
	// The fallthrough only reaches the sync check after the worktree was
	// actually created from the existing branch — check that it happened.
	if _, err := exec.Command("git", "-C", wtPath, "rev-parse", "HEAD").Output(); err != nil {
		t.Fatalf("worktree not created from existing branch: %v", err)
	}
}

// TestRunPRDeclinedResetCompletesTheRun is the guard against an infinite
// prompt loop. Without a distinct "asked and declined" flag, replaying with
// ResetToPR still false would return the identical Confirm forever, and the
// caller's only escape would be abandoning a worktree git already created.
func TestRunPRDeclinedResetCompletesTheRun(t *testing.T) {
	repo := prRepo(t, testPRBranch)
	base := t.TempDir()
	wtPath := filepath.Join(base, "pr-1")
	stubPR(t, gitutil.PRWorktreeResult{
		CreateResult: gitutil.CreateResult{Path: wtPath, Branch: testPRBranch},
		Status:       gitutil.PRWorktreeBranchExists,
		LocalHead:    "aaa", RemoteHead: "bbb", FetchRef: "refs/pr-review/1",
	})

	res := Run(nil, config.Config{WorktreesBase: base}, Options{
		Input: "https://github.com/owner/repo/pull/1", RepoRoot: repo,
		ReuseBranch: true, DeclineReset: true,
	}, nil)

	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}
	if res.Confirm != nil {
		t.Fatalf("confirm = %#v, want nil — a declined reset must finish the run", res.Confirm)
	}
	if got := statusOf(res, StepCreateWorktree); got != StatusDone {
		t.Fatalf("create_worktree = %q, want done", got)
	}
	// finalize must have been reached: these would still be pending otherwise.
	if got := statusOf(res, StepRegister); got == StatusPending {
		t.Fatal("register still pending — finalize was never reached")
	}
	if got := statusOf(res, StepKubeconfig); got == StatusPending {
		t.Fatal("kubeconfig still pending — finalize was never reached")
	}
	if res.Path != wtPath {
		t.Fatalf("path = %q, want %q", res.Path, wtPath)
	}
}

func TestRunPRTracksThePRAsPrimaryResource(t *testing.T) {
	repo := prRepo(t, "")
	base := t.TempDir()
	conn, err := wdb.OpenAt(filepath.Join(base, "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })

	wtPath := filepath.Join(base, "pr-1")
	if err := os.MkdirAll(wtPath, 0o755); err != nil {
		t.Fatal(err)
	}
	stubPR(t, gitutil.PRWorktreeResult{
		CreateResult: gitutil.CreateResult{Path: wtPath, Branch: testPRBranch, Created: true},
		Status:       gitutil.PRWorktreeCreated,
		RemoteHead:   "bbb", FetchRef: "refs/pr-review/1",
	})

	res := Run(conn, config.Config{WorktreesBase: base},
		Options{Input: "https://github.com/owner/repo/pull/1", RepoRoot: repo}, nil)
	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}
	if res.Confirm != nil {
		t.Fatalf("unexpected confirmation: %#v", res.Confirm)
	}

	tracked, err := resources.Load(conn, wtPath)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range tracked {
		if r.Type == "pr" && r.ID == "owner/repo#1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("tracked = %#v, want a pr resource owner/repo#1", tracked)
	}
}

func TestRunPRRejectsAMismatchedRepo(t *testing.T) {
	repo := prRepo(t, "")
	base := t.TempDir()
	stubPR(t, gitutil.PRWorktreeResult{})

	res := Run(nil, config.Config{WorktreesBase: base},
		Options{Input: "https://github.com/other/thing/pull/1", RepoRoot: repo}, nil)

	if res.Err == nil {
		t.Fatal("want an error when the repo root is not a clone of the PR's repo")
	}
	if got := statusOf(res, StepCreateWorktree); got != StatusFailed {
		t.Fatalf("create_worktree = %q, want failed", got)
	}
}
