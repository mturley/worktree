package worktreenew

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/github"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/registry"
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
	stubPRInfo(t, &github.PRInfo{
		Number: 1, Title: "Some Title", HeadRef: "feature",
		URL: "https://github.com/owner/repo/pull/1",
	}, res)
}

// stubPRInfo is stubPR with the PR's own metadata under test control, for the
// cases that care what the title and body say.
func stubPRInfo(t *testing.T, info *github.PRInfo, res gitutil.PRWorktreeResult) {
	t.Helper()
	origFetch, origCreate := fetchPRInfo, createPRWorktree
	fetchPRInfo = func(owner, repo string, number int) (*github.PRInfo, error) {
		out := *info
		out.Number = number
		return &out, nil
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

// failTracking makes SetPRTracking fail for the duration of a test. Tracking
// is the one non-fatal failure on the PR path, so it is the only way to reach
// the warning-detail branch.
func failTracking(t *testing.T) {
	t.Helper()
	orig := setPRTracking
	setPRTracking = func(repoRoot, branch, remote string, n int) error {
		return errors.New("git config: permission denied")
	}
	t.Cleanup(func() { setPRTracking = orig })
}

// TestRunPRTrackingFailureRecordsOneStep is the guard for a bug that was both
// duplicated AND silent: runPR used to record create_worktree itself with the
// tracking warning, and then Run recorded it a second time with the plain
// path. The step list is keyed by StepKey downstream — React renders
// `key={s.key}` and streaming consumers upsert by key — so the second record
// overwrote the first, throwing away the only surface where a tracking failure
// was ever visible.
func TestRunPRTrackingFailureRecordsOneStep(t *testing.T) {
	repo := prRepo(t, "")
	base := t.TempDir()
	wtPath := filepath.Join(base, "pr-1")
	if err := os.MkdirAll(wtPath, 0o755); err != nil {
		t.Fatal(err)
	}
	stubPR(t, gitutil.PRWorktreeResult{
		CreateResult: gitutil.CreateResult{Path: wtPath, Branch: testPRBranch, Created: true},
		Status:       gitutil.PRWorktreeCreated,
		RemoteHead:   "bbb", FetchRef: "refs/pr-review/1",
	})
	failTracking(t)

	var observed []Step
	res := Run(nil, config.Config{WorktreesBase: base},
		Options{Input: "https://github.com/owner/repo/pull/1", RepoRoot: repo},
		func(s Step) { observed = append(observed, s) })

	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}

	var got []Step
	for _, s := range res.Steps {
		if s.Key == StepCreateWorktree {
			got = append(got, s)
		}
	}
	if len(got) != 1 {
		t.Fatalf("create_worktree appears %d times, want exactly 1: %#v", len(got), got)
	}
	if !strings.Contains(got[0].Detail, "tracking not set") {
		t.Fatalf("detail = %q, want it to mention the tracking failure", got[0].Detail)
	}
	if !strings.Contains(got[0].Detail, wtPath) {
		t.Fatalf("detail = %q, want it to still carry the worktree path", got[0].Detail)
	}
	// Tracking is a convenience, not the deliverable: the worktree exists and
	// is usable, so the step is done-with-a-warning, not failed.
	if got[0].Status != StatusDone {
		t.Fatalf("status = %q, want done — a tracking failure does not break creation", got[0].Status)
	}

	// The observer must see exactly ONE terminal record for the step: a
	// streaming consumer that upserts by key would otherwise have the warning
	// overwritten mid-flight. The pending record that precedes it is the
	// deliberate in-progress signal, not a competing outcome, so it is
	// excluded — what must never happen is two settled records under one key.
	var terminal []Step
	for _, s := range observed {
		if s.Key == StepCreateWorktree && s.Status != StatusPending {
			terminal = append(terminal, s)
		}
	}
	if len(terminal) != 1 {
		t.Fatalf("observer saw %d settled create_worktree records, want exactly 1: %#v",
			len(terminal), terminal)
	}
	if !strings.Contains(terminal[0].Detail, "tracking not set") {
		t.Fatalf("observed detail = %q, want the warning", terminal[0].Detail)
	}
}

// TestSlowStepsAnnounceThemselvesBeforeRunning pins the in-progress signal.
// The observer used to hear about a step only when it finished, which left
// `worktree add` silent through the `gh` fetch and the git work — several
// seconds of dead terminal. pull and create_worktree now report pending first
// and their outcome after, and the pending record must not survive into the
// final step list.
func TestSlowStepsAnnounceThemselvesBeforeRunning(t *testing.T) {
	repo := newRepo(t)
	cfg := config.Config{WorktreesBase: t.TempDir()}

	var observed []Step
	res := Run(nil, cfg, Options{Input: "my-feature", RepoRoot: repo},
		func(s Step) { observed = append(observed, s) })
	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}

	first := map[StepKey]Status{}
	for _, s := range observed {
		if _, ok := first[s.Key]; !ok {
			first[s.Key] = s.Status
		}
	}
	if first[StepCreateWorktree] != StatusPending {
		t.Fatalf("first create_worktree record = %q, want pending — nothing tells the user work started",
			first[StepCreateWorktree])
	}
	if got := statusOf(res, StepCreateWorktree); got != StatusDone {
		t.Fatalf("final create_worktree = %q, want done — pending must be replaced", got)
	}

	// Same for pull when it is actually requested.
	observed = nil
	Run(nil, cfg, Options{Input: "other-feature", RepoRoot: repo, Pull: true},
		func(s Step) { observed = append(observed, s) })
	if len(observed) == 0 || observed[0].Key != StepPull || observed[0].Status != StatusPending {
		t.Fatalf("first observed record = %#v, want a pending pull", observed[0])
	}
}

// TestRecordReplacesRatherThanDuplicates pins the belt-and-braces guarantee
// directly, so no future call site can reintroduce a duplicate key.
func TestRecordReplacesRatherThanDuplicates(t *testing.T) {
	r := &runner{}
	r.record(StepCreateWorktree, StatusDone, "first")
	r.record(StepCreateWorktree, StatusFailed, "second")

	n := 0
	var last Step
	for _, s := range r.finish() {
		if s.Key == StepCreateWorktree {
			n++
			last = s
		}
	}
	if n != 1 {
		t.Fatalf("create_worktree appears %d times, want exactly 1", n)
	}
	if last.Detail != "second" || last.Status != StatusFailed {
		t.Fatalf("= %#v, want the later record to win", last)
	}
}

// TestRunPRDeclinedResetOnExistingDirFinalizes covers the other route into the
// decline: an existing worktree DIRECTORY that has diverged from the PR head,
// with no branch-reuse question in front of it. The directory is already on
// disk here, so an abort would strand exactly what it did in the reuse case —
// unregistered, holding no port range, invisible to the tool.
func TestRunPRDeclinedResetOnExistingDirFinalizes(t *testing.T) {
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
		CreateResult: gitutil.CreateResult{Path: wtPath, Branch: testPRBranch},
		Status:       gitutil.PRWorktreeExistingDir,
		LocalHead:    "aaa", RemoteHead: "bbb", FetchRef: "refs/pr-review/1",
	})

	// Without DeclineReset this same call returns a ConfirmResetToPR — assert
	// that first, so the test cannot pass by the question never being asked.
	asked := Run(conn, config.Config{WorktreesBase: base},
		Options{Input: "https://github.com/owner/repo/pull/1", RepoRoot: repo}, nil)
	if asked.Confirm == nil || asked.Confirm.Key != ConfirmResetToPR {
		t.Fatalf("confirm = %#v, want ConfirmResetToPR", asked.Confirm)
	}

	res := Run(conn, config.Config{WorktreesBase: base}, Options{
		Input: "https://github.com/owner/repo/pull/1", RepoRoot: repo,
		DeclineReset: true,
	}, nil)

	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}
	if res.Confirm != nil {
		t.Fatalf("confirm = %#v, want nil — a declined reset must finish the run", res.Confirm)
	}
	if got := statusOf(res, StepRegister); got == StatusPending {
		t.Fatalf("register = %q — finalize was never reached", got)
	}
	if got := statusOf(res, StepKubeconfig); got == StatusPending {
		t.Fatalf("kubeconfig = %q — finalize was never reached", got)
	}
	entries, err := registry.List(conn)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range entries {
		if e.Path == wtPath {
			found = true
		}
	}
	if !found {
		t.Fatal("worktree not registered after a declined reset — it would be stranded")
	}
}

// TestRunPRDetectsJiraKeysFromTitleAndBody pins the title/body threading out
// of runPR. The keys reach Jira detection only through prOutcome; drop them
// and a PR worktree would silently stop tracking the issues its description
// names — the CLI did this before the runner existed.
func TestRunPRDetectsJiraKeysFromTitleAndBody(t *testing.T) {
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
	stubPRInfo(t, &github.PRInfo{
		Title: "PROJ-7 fix the thing", Body: "Follow-up to PROJ-8.\n<!-- PROJ-9 is an example -->",
		HeadRef: "feature", URL: "https://github.com/owner/repo/pull/1",
	}, gitutil.PRWorktreeResult{
		CreateResult: gitutil.CreateResult{Path: wtPath, Branch: testPRBranch, Created: true},
		Status:       gitutil.PRWorktreeCreated,
		RemoteHead:   "bbb", FetchRef: "refs/pr-review/1",
	})

	cfg := config.Config{WorktreesBase: base}
	cfg.Jira.Projects = []string{"PROJ"}

	res := Run(conn, cfg,
		Options{Input: "https://github.com/owner/repo/pull/1", RepoRoot: repo}, nil)
	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}

	tracked, err := resources.Load(conn, wtPath)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, r := range tracked {
		if r.Type == "jira" {
			got[r.ID] = true
		}
	}
	if !got["PROJ-7"] || !got["PROJ-8"] {
		t.Fatalf("tracked jira issues = %v, want PROJ-7 and PROJ-8 from the PR title and body", got)
	}
	if got["PROJ-9"] {
		t.Fatal("PROJ-9 came from an HTML comment and must not be tracked")
	}
}
