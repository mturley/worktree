package worktreedel

import (
	"database/sql"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

// fixture builds a real repo with a real linked worktree, registered in a real
// DB — the runner coordinates git and the DB, so stubbing either would test
// nothing that can break.
func fixture(t *testing.T) (conn *sql.DB, cfg config.Config, repoRoot, wtPath, name string) {
	t.Helper()
	base := t.TempDir()
	repoRoot = filepath.Join(base, "repo")
	os.MkdirAll(repoRoot, 0o755)

	git := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	git(repoRoot, "init", "-b", "main")
	os.WriteFile(filepath.Join(repoRoot, "a.txt"), []byte("one\n"), 0o644)
	git(repoRoot, "add", "a.txt")
	git(repoRoot, "commit", "-m", "init")

	worktreesBase := filepath.Join(base, "worktrees")
	name = "wt-1"
	wtPath = filepath.Join(worktreesBase, name)
	git(repoRoot, "worktree", "add", "-b", "feature", wtPath)

	conn, err := wdb.OpenAt(filepath.Join(base, "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	registry.Register(conn, registry.Entry{
		Path: wtPath, Repo: "repo", RepoRoot: repoRoot, Branch: "feature",
		CreatedAt: "2026-08-26T00:00:00Z",
	})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"})

	cfg = config.Config{WorktreesBase: worktreesBase}
	return conn, cfg, repoRoot, wtPath, name
}

func byKey(res Result, key StepKey) Step {
	for _, s := range res.Steps {
		if s.Key == key {
			return s
		}
	}
	return Step{}
}

func TestRunCleanDelete(t *testing.T) {
	conn, cfg, _, wtPath, _ := fixture(t)

	var seen []StepKey
	res := Run(conn, cfg, Options{Path: wtPath}, func(s Step) { seen = append(seen, s.Key) })

	if res.Err != nil || res.NeedsForce != "" {
		t.Fatalf("clean delete: err=%v needsForce=%q", res.Err, res.NeedsForce)
	}
	if _, err := os.Stat(wtPath); !os.IsNotExist(err) {
		t.Fatal("worktree directory still present")
	}
	for _, key := range []StepKey{StepRemoveDirectory, StepReleasePorts, StepUnregister, StepRemoveResources, StepPrune} {
		if got := byKey(res, key).Status; got != StatusDone && got != StatusSkipped {
			t.Fatalf("step %s = %s, want done or skipped", key, got)
		}
	}
	// The observer is how the CLI keeps its per-step spinners.
	if len(seen) != len(res.Steps) {
		t.Fatalf("observer saw %d steps, result has %d", len(seen), len(res.Steps))
	}
	if e, err := registry.Get(conn, wtPath); err != nil || e != nil {
		t.Fatalf("registry row survived: %+v (err %v)", e, err)
	}
}

// Re-running after a successful delete must be harmless: granting a force
// re-posts the WHOLE request, so the runner has to tolerate work already done.
func TestRunIsIdempotent(t *testing.T) {
	conn, cfg, _, wtPath, _ := fixture(t)
	Run(conn, cfg, Options{Path: wtPath}, nil)

	res := Run(conn, cfg, Options{Path: wtPath}, nil)
	if res.Err != nil {
		t.Fatalf("second run errored: %v", res.Err)
	}
	if got := byKey(res, StepRemoveDirectory).Status; got != StatusSkipped {
		t.Fatalf("remove_directory on a second run = %s, want skipped", got)
	}
	for _, s := range res.Steps {
		if s.Status == StatusFailed {
			t.Fatalf("step %s failed on an idempotent re-run: %s", s.Key, s.Detail)
		}
	}
}

// The common case for a worktree branch, and the reason the checkbox needs an
// escalation at all.
func TestRunUnmergedBranchNeedsForce(t *testing.T) {
	conn, cfg, _, wtPath, _ := fixture(t)
	os.WriteFile(filepath.Join(wtPath, "b.txt"), []byte("two\n"), 0o644)
	for _, args := range [][]string{{"add", "b.txt"}, {"commit", "-m", "unmerged"}} {
		cmd := exec.Command("git", append([]string{"-C", wtPath}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}

	res := Run(conn, cfg, Options{Path: wtPath, DeleteBranch: true}, nil)
	if res.NeedsForce != StepDeleteBranch {
		t.Fatalf("needsForce = %q, want %s", res.NeedsForce, StepDeleteBranch)
	}
	if byKey(res, StepDeleteBranch).Detail == "" {
		t.Fatal("no git output to show the user")
	}

	forced := Run(conn, cfg, Options{Path: wtPath, DeleteBranch: true, ForceBranch: true}, nil)
	if forced.NeedsForce != "" || byKey(forced, StepDeleteBranch).Status != StatusDone {
		t.Fatalf("forced branch delete: %+v", byKey(forced, StepDeleteBranch))
	}
}

// A hard delete_branch failure (branch already gone, unlike an unmerged
// refusal) must not abort the run: forcing wouldn't help, so there is nothing
// for an abort to preserve, and stopping would strand the registry row and
// port range forever since remove_directory would just skip on every retry.
func TestRunHardBranchFailureDoesNotAbort(t *testing.T) {
	conn, cfg, repoRoot, wtPath, _ := fixture(t)
	registry.Register(conn, registry.Entry{
		Path: wtPath, Repo: "repo", RepoRoot: repoRoot, Branch: "no-such-branch",
		CreatedAt: "2026-08-26T00:00:00Z",
	})

	res := Run(conn, cfg, Options{Path: wtPath, DeleteBranch: true}, nil)
	if got := byKey(res, StepDeleteBranch).Status; got != StatusFailed {
		t.Fatalf("delete_branch status = %s, want failed", got)
	}
	if res.Err != nil || res.NeedsForce != "" {
		t.Fatalf("hard branch failure must not set Err/NeedsForce: err=%v needsForce=%q", res.Err, res.NeedsForce)
	}
	if got := byKey(res, StepUnregister).Status; got != StatusDone {
		t.Fatalf("unregister = %s, want done — cleanup must run anyway", got)
	}
	if e, err := registry.Get(conn, wtPath); err != nil || e != nil {
		t.Fatalf("registry row survived a hard branch failure: %+v (err %v)", e, err)
	}
}

// Without DeleteBranch the branch is untouched, and the step is not reported at
// all — a stepper should not show a stage that was never going to run.
func TestRunLeavesBranchAloneByDefault(t *testing.T) {
	conn, cfg, repoRoot, wtPath, _ := fixture(t)
	Run(conn, cfg, Options{Path: wtPath}, nil)

	out, _ := exec.Command("git", "-C", repoRoot, "branch", "--list", "feature").Output()
	if len(out) == 0 {
		t.Fatal("branch was deleted without being asked for")
	}
	res := Run(conn, cfg, Options{Path: wtPath}, nil)
	if byKey(res, StepDeleteBranch).Key != "" {
		t.Fatal("delete_branch step reported when not requested")
	}
}

// An unreachable worktree must not be silently unregistered: the row is the
// only record that the directory exists at all.
func TestRunAbortsWhenDirectoryCannotBeRemoved(t *testing.T) {
	conn, cfg, _, wtPath, _ := fixture(t)
	// A path outside WorktreesBase cannot be force-removed, and git will not
	// remove it either — this is the shape of "the server cannot reach it".
	cfg.WorktreesBase = filepath.Join(t.TempDir(), "elsewhere")

	res := Run(conn, cfg, Options{Path: wtPath, ForceDirectory: true}, nil)
	if res.Err == nil {
		t.Fatal("expected a hard error when the directory cannot be removed")
	}
	if byKey(res, StepRemoveDirectory).Status != StatusFailed {
		t.Fatalf("remove_directory = %s, want failed", byKey(res, StepRemoveDirectory).Status)
	}
	if got := byKey(res, StepUnregister).Status; got != StatusPending {
		t.Fatalf("unregister = %s, want pending — the run must abort", got)
	}
	if e, _ := registry.Get(conn, wtPath); e == nil {
		t.Fatal("registry row was dropped for a worktree still on disk")
	}
}

func TestRunRejectsUnknownWorktree(t *testing.T) {
	conn, cfg, _, _, _ := fixture(t)
	res := Run(conn, cfg, Options{Path: filepath.Join(t.TempDir(), "not-a-worktree")}, nil)
	if res.Err == nil {
		t.Fatal("expected an error for a path that is neither registered nor a git worktree")
	}
}

// unregisteredFixture builds a real repo with a linked worktree that is NOT
// registered in the DB — the shape of a worktree created by hand with plain
// `git worktree add` rather than through this tool. If detach is true, the
// worktree's HEAD is left detached (no branch) instead of on a feature branch.
func unregisteredFixture(t *testing.T, detach bool) (conn *sql.DB, cfg config.Config, repoRoot, wtPath string) {
	t.Helper()
	base := t.TempDir()
	repoRoot = filepath.Join(base, "repo")
	os.MkdirAll(repoRoot, 0o755)

	git := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	git(repoRoot, "init", "-b", "main")
	os.WriteFile(filepath.Join(repoRoot, "a.txt"), []byte("one\n"), 0o644)
	git(repoRoot, "add", "a.txt")
	git(repoRoot, "commit", "-m", "init")

	worktreesBase := filepath.Join(base, "worktrees")
	wtPath = filepath.Join(worktreesBase, "wt-1")
	git(repoRoot, "worktree", "add", "-b", "feature", wtPath)
	if detach {
		git(wtPath, "checkout", "--detach", "HEAD")
	}

	conn, err := wdb.OpenAt(filepath.Join(base, "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })

	cfg = config.Config{WorktreesBase: worktreesBase}
	return conn, cfg, repoRoot, wtPath
}

// A worktree created by hand (no registry row) must still be fully cleaned up:
// resolve() has to find the MAIN repo root (not the worktree's own path, which
// `git rev-parse --show-toplevel` would return) so that prune runs against the
// right directory, and it has to discover the checked-out branch itself so an
// explicit DeleteBranch request is actually honored.
func TestRunUnregisteredWorktreeFullDelete(t *testing.T) {
	conn, cfg, repoRoot, wtPath := unregisteredFixture(t, false)

	res := Run(conn, cfg, Options{Path: wtPath, DeleteBranch: true}, nil)
	if res.Err != nil || res.NeedsForce != "" {
		t.Fatalf("unregistered delete: err=%v needsForce=%q", res.Err, res.NeedsForce)
	}
	if got := byKey(res, StepDeleteBranch).Status; got != StatusDone {
		t.Fatalf("delete_branch = %s, want done: %+v", got, byKey(res, StepDeleteBranch))
	}
	if got := byKey(res, StepPrune).Status; got != StatusDone {
		t.Fatalf("prune = %s, want done — resolve() must find the MAIN repo root, not the worktree's own path", got)
	}
	out, _ := exec.Command("git", "-C", repoRoot, "branch", "--list", "feature").Output()
	if len(out) != 0 {
		t.Fatalf("branch still present after an unregistered DeleteBranch request: %q", out)
	}
}

// A detached-HEAD worktree has no branch to delete. Reporting that as skipped
// would look like the request succeeded when nothing happened; it must fail
// visibly instead.
func TestRunUnregisteredDetachedHeadDeleteBranchFails(t *testing.T) {
	conn, cfg, _, wtPath := unregisteredFixture(t, true)

	res := Run(conn, cfg, Options{Path: wtPath, DeleteBranch: true}, nil)
	if got := byKey(res, StepDeleteBranch).Status; got != StatusFailed {
		t.Fatalf("delete_branch = %s, want failed for a detached HEAD", got)
	}
}

var _ = ports.Release
