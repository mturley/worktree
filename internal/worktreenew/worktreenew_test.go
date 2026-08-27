package worktreenew

import (
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
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

// TestRunReplayWithRealDBHasNoFailures is the guard for the stateless
// confirmation design: a later task answers a confirmation by re-POSTing the
// whole request, so a second Run over already-finished work — with a REAL
// database, unlike TestRunReplayIsSkippedNotFailed's conn=nil case where
// allocate_ports/register/resources are trivially skipped without ever
// executing — must never report `failed` on any step, and must leave the
// registry and port allocation exactly as the first run left them.
func TestRunReplayWithRealDBHasNoFailures(t *testing.T) {
	repo := newRepo(t)
	base := t.TempDir()
	conn, err := wdb.OpenAt(filepath.Join(base, "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })

	cfg := config.Config{WorktreesBase: filepath.Join(base, "worktrees")}
	opts := Options{Input: "my-feature", RepoRoot: repo, CopyDotfiles: true}

	first := Run(conn, cfg, opts, nil)
	if first.Err != nil {
		t.Fatalf("first run errored: %v", first.Err)
	}

	second := Run(conn, cfg, opts, nil)
	if second.Err != nil {
		t.Fatalf("replay errored: %v", second.Err)
	}

	if got := statusOf(second, StepCreateWorktree); got != StatusSkipped {
		t.Fatalf("replayed create_worktree = %q, want skipped", got)
	}

	for _, s := range second.Steps {
		if s.Status == StatusFailed {
			t.Fatalf("step %q failed on replay: %s", s.Key, s.Detail)
		}
	}

	entries, err := registry.List(conn)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, e := range entries {
		if e.Path == second.Path {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("registry has %d rows for %s, want exactly 1", count, second.Path)
	}

	firstAlloc, err := ports.Allocate(conn, filepath.Base(first.Path))
	if err != nil {
		t.Fatal(err)
	}
	secondAlloc, err := ports.Allocate(conn, filepath.Base(second.Path))
	if err != nil {
		t.Fatal(err)
	}
	if firstAlloc.Slot != secondAlloc.Slot {
		t.Fatalf("port slot changed across replay: first=%d second=%d", firstAlloc.Slot, secondAlloc.Slot)
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

// TestRunDetectsJiraIssueFromBranchName guards the auto-detection that used to
// live in cmd/root.go (detectAndSaveJiraIssues). It ran from the terminal only;
// once the web UI drives this runner, leaving it there would make the two
// surfaces disagree about which issues a worktree tracks.
func TestRunDetectsJiraIssueFromBranchName(t *testing.T) {
	repo := newRepo(t)
	base := t.TempDir()
	conn, err := wdb.OpenAt(filepath.Join(base, "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })

	cfg := config.Config{WorktreesBase: filepath.Join(base, "worktrees")}
	cfg.Jira.Projects = []string{"PROJ"}

	res := Run(conn, cfg, Options{Input: "proj-123-fix-thing", RepoRoot: repo}, nil)
	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}
	if got := statusOf(res, StepResources); got != StatusDone {
		t.Fatalf("resources = %q, want done", got)
	}

	tracked, err := resources.Load(conn, res.Path)
	if err != nil {
		t.Fatal(err)
	}
	var keys []string
	for _, r := range tracked {
		if r.Type == "jira" {
			keys = append(keys, r.ID)
		}
	}
	if len(keys) != 1 || keys[0] != "PROJ-123" {
		t.Fatalf("tracked jira issues = %v, want [PROJ-123]", keys)
	}

	// A replay must not add the issue a second time.
	if replay := Run(conn, cfg, Options{Input: "proj-123-fix-thing", RepoRoot: repo}, nil); replay.Err != nil {
		t.Fatalf("replay errored: %v", replay.Err)
	}
	after, err := resources.Load(conn, res.Path)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, r := range after {
		if r.Type == "jira" && r.ID == "PROJ-123" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("PROJ-123 tracked %d times after replay, want 1", n)
	}
}
