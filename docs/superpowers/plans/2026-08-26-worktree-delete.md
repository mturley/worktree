# Delete a Worktree From the Web UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete a worktree from the web UI with the CLI's care — typed confirmation, escalation to forced removal only when git refuses, a per-step report of what actually happened, and optional branch deletion.

**Architecture:** The cleanup sequence moves out of `cmd/delete.go` into a new `internal/worktreedel` package that runs every step and reports each one to an observer callback. The CLI drives it with spinners and prompts; a new `POST /api/worktrees/delete` collects the steps into a JSON response. There is no server-side session: granting a force re-posts the whole request, so every step is idempotent and already-done work reports as `skipped`.

**Tech Stack:** Go 1.22+ (stdlib `net/http` mux, `database/sql`, SQLite), React 19 + Mantine 7 + TanStack Query 5 + wouter 3, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-26-worktree-delete-design.md`

## Global Constraints

- Commit with `--signoff`. Never `git add -A` or `git add .` — add files by name.
- Go tests run with `-count=1` (the cache has masked real failures in this repo before).
- UI checks are `npx tsc --noEmit` **and** `npx vitest run`, both from `ui/`. Vitest passing alone is not enough: esbuild strips types without checking them, so only `tsc` catches type errors.
- `needs_force` is always HTTP **200** with a marker in the body, never 4xx/5xx.
- The branch is never deleted unless explicitly requested: checkbox unchecked by default, CLI prompt defaulting to **no**.
- A failing `remove_directory` aborts the run; a failing cleanup step does not.
- Follow existing webui patterns: `writeJSON(w, status, v)` and `writeError(w, status, msg)` from `internal/webui/server.go`.
- The UI is dark-only. Do not add light-scheme styling.

---

### Task 1: `gitutil.DeleteBranch`

**Files:**
- Modify: `internal/gitutil/worktree.go` (append; `ErrNeedsForce` is defined there at :169)
- Test: `internal/gitutil/branch_test.go` (create)

**Interfaces:**
- Consumes: `*gitutil.ErrNeedsForce` (existing, `internal/gitutil/worktree.go:169`)
- Produces: `func DeleteBranch(repoRoot, branch string, force bool) error`

- [ ] **Step 1: Write the failing tests**

Create `internal/gitutil/branch_test.go`:

```go
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
	if err := DeleteBranch(dir, "nope", false); err == nil {
		t.Fatal("deleting a non-existent branch should error")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/gitutil/ -run TestDeleteBranch -count=1`
Expected: FAIL — `undefined: DeleteBranch`

- [ ] **Step 3: Implement**

Append to `internal/gitutil/worktree.go`:

```go
// DeleteBranch deletes a local branch in repoRoot.
//
// With force=false it uses `git branch -d`, which refuses to delete a branch
// that is not fully merged. That refusal comes back as *ErrNeedsForce carrying
// git's message, so callers escalate it the same way they escalate a worktree
// directory git will not remove — one shape for both confirmations.
//
// Any other failure (no such branch, not a repo) is returned as a plain error:
// forcing would not help.
func DeleteBranch(repoRoot, branch string, force bool) error {
	flag := "-d"
	if force {
		flag = "-D"
	}
	out, err := exec.Command("git", "-C", repoRoot, "branch", flag, branch).CombinedOutput()
	if err == nil {
		return nil
	}
	msg := strings.TrimSpace(string(out))
	if !force && strings.Contains(msg, "not fully merged") {
		return &ErrNeedsForce{GitOutput: msg}
	}
	return fmt.Errorf("git branch %s %s: %s", flag, branch, msg)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/gitutil/ -count=1`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/gitutil/worktree.go internal/gitutil/branch_test.go
git commit --signoff -m "feat(gitutil): DeleteBranch, escalating unmerged refusals as ErrNeedsForce

git branch -d refuses to delete an unmerged branch, and a worktree's branch is
usually unmerged. Returning that refusal as ErrNeedsForce gives it the same
shape as a worktree directory git will not remove, so callers handle one
escalation pattern rather than two."
```

---

### Task 2: The shared deletion runner

**Files:**
- Create: `internal/worktreedel/worktreedel.go`
- Test: `internal/worktreedel/worktreedel_test.go`

**Interfaces:**
- Consumes: `gitutil.RemoveWorktree`, `gitutil.ForceRemoveWorktree`, `gitutil.PruneWorktrees`, `gitutil.DeleteBranch` (Task 1), `gitutil.ErrNeedsForce`, `registry.Get`, `registry.Unregister`, `ports.Release`, `resources.RemoveAll`, `env.KubeconfigPath`, `config.Config`
- Produces:
  - `type StepKey string` with constants `StepRemoveDirectory`, `StepReleasePorts`, `StepUnregister`, `StepRemoveResources`, `StepRemoveKubeconfig`, `StepPrune`, `StepDeleteBranch`
  - `type Status string` with `StatusDone`, `StatusSkipped`, `StatusFailed`, `StatusNeedsForce`, `StatusPending`
  - `type Step struct { Key StepKey; Label, Detail string; Status Status }`
  - `type Options struct { Path string; DeleteBranch, ForceDirectory, ForceBranch bool }`
  - `type Result struct { Steps []Step; NeedsForce StepKey; Err error }`
  - `func Run(conn *sql.DB, cfg config.Config, opts Options, observe func(Step)) Result`

- [ ] **Step 1: Write the failing tests**

Create `internal/worktreedel/worktreedel_test.go`:

```go
package worktreedel

import (
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

var _ = ports.Release
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/worktreedel/ -count=1`
Expected: FAIL — package does not compile (`undefined: Run`)

- [ ] **Step 3: Implement the runner**

Create `internal/worktreedel/worktreedel.go`:

```go
// Package worktreedel runs the worktree deletion sequence.
//
// It exists so the CLI and the web UI share one sequence rather than two
// copies. The steps used to live inline in cmd/delete.go; a second copy in the
// HTTP handler would drift silently, and the symptom — a worktree deleted from
// the UI that still holds its port range — stays invisible until the range
// runs out.
package worktreedel

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

type StepKey string

const (
	StepRemoveDirectory  StepKey = "remove_directory"
	StepReleasePorts     StepKey = "release_ports"
	StepUnregister       StepKey = "unregister"
	StepRemoveResources  StepKey = "remove_resources"
	StepRemoveKubeconfig StepKey = "remove_kubeconfig"
	StepPrune            StepKey = "prune"
	StepDeleteBranch     StepKey = "delete_branch"
)

type Status string

const (
	StatusDone       Status = "done"
	StatusSkipped    Status = "skipped"
	StatusFailed     Status = "failed"
	StatusNeedsForce Status = "needs_force"
	StatusPending    Status = "pending"
)

type Step struct {
	Key    StepKey `json:"key"`
	Label  string  `json:"label"`
	Status Status  `json:"status"`
	Detail string  `json:"detail,omitempty"`
}

type Options struct {
	Path           string
	DeleteBranch   bool
	ForceDirectory bool
	ForceBranch    bool
}

type Result struct {
	Steps      []Step  `json:"steps"`
	NeedsForce StepKey `json:"needs_force,omitempty"`
	Err        error   `json:"-"`
}

var labels = map[StepKey]string{
	StepRemoveDirectory:  "Remove worktree directory",
	StepReleasePorts:     "Release port range",
	StepUnregister:       "Unregister worktree",
	StepRemoveResources:  "Remove tracked resources",
	StepRemoveKubeconfig: "Remove kubeconfig",
	StepPrune:            "Prune git worktree list",
	StepDeleteBranch:     "Delete branch",
}

// Run executes the deletion sequence, reporting each step to observe (which may
// be nil) as it completes.
//
// Every run starts from the top: there is no session. Granting a force
// re-invokes Run with that force set, so each step tolerates work already done
// and reports it as skipped rather than failing.
func Run(conn *sql.DB, cfg config.Config, opts Options, observe func(Step)) Result {
	res := Result{}
	keys := []StepKey{
		StepRemoveDirectory, StepReleasePorts, StepUnregister,
		StepRemoveResources, StepRemoveKubeconfig, StepPrune,
	}
	if opts.DeleteBranch {
		keys = append(keys, StepDeleteBranch)
	}
	for _, k := range keys {
		res.Steps = append(res.Steps, Step{Key: k, Label: labels[k], Status: StatusPending})
	}

	set := func(key StepKey, status Status, detail string) {
		for i := range res.Steps {
			if res.Steps[i].Key == key {
				res.Steps[i].Status = status
				res.Steps[i].Detail = detail
				if observe != nil {
					observe(res.Steps[i])
				}
				return
			}
		}
	}

	repoRoot, repo, branch, err := resolve(conn, opts.Path)
	if err != nil {
		res.Err = err
		return res
	}
	name := filepath.Base(opts.Path)

	// 1. The directory. A hard failure here aborts: unregistering a worktree
	// still on disk strands it — invisible to the tool, still holding its ports.
	switch _, statErr := os.Stat(opts.Path); {
	case os.IsNotExist(statErr):
		set(StepRemoveDirectory, StatusSkipped, "already removed")
	default:
		var rmErr error
		if opts.ForceDirectory {
			rmErr = gitutil.ForceRemoveWorktree(repoRoot, cfg.WorktreesBase, opts.Path)
		} else {
			rmErr = gitutil.RemoveWorktree(repoRoot, opts.Path)
		}
		var needsForce *gitutil.ErrNeedsForce
		switch {
		case rmErr == nil:
			set(StepRemoveDirectory, StatusDone, "")
		case errors.As(rmErr, &needsForce):
			set(StepRemoveDirectory, StatusNeedsForce, needsForce.GitOutput)
			res.NeedsForce = StepRemoveDirectory
			return res
		default:
			set(StepRemoveDirectory, StatusFailed, rmErr.Error())
			res.Err = rmErr
			return res
		}
	}

	// 2-5. Cleanup. These do NOT abort on failure: the CLI has always warned
	// and carried on, and stopping would leave more mess than continuing. The
	// difference is the failure is now visible instead of scrolling past.
	if err := ports.Release(conn, name); err != nil {
		set(StepReleasePorts, StatusFailed, err.Error())
	} else {
		set(StepReleasePorts, StatusDone, "")
	}

	if err := registry.Unregister(conn, opts.Path); err != nil {
		set(StepUnregister, StatusFailed, err.Error())
	} else {
		set(StepUnregister, StatusDone, "")
	}

	if err := resources.RemoveAll(conn, opts.Path); err != nil {
		set(StepRemoveResources, StatusFailed, err.Error())
	} else {
		set(StepRemoveResources, StatusDone, "")
	}

	kubePath := env.KubeconfigPath(repo, name)
	switch err := os.Remove(kubePath); {
	case err == nil:
		set(StepRemoveKubeconfig, StatusDone, kubePath)
	case os.IsNotExist(err):
		set(StepRemoveKubeconfig, StatusSkipped, "none found")
	default:
		set(StepRemoveKubeconfig, StatusFailed, err.Error())
	}

	if err := gitutil.PruneWorktrees(repoRoot); err != nil {
		set(StepPrune, StatusFailed, err.Error())
	} else {
		set(StepPrune, StatusDone, "")
	}

	// 6. The branch, only when asked. Unmerged is the common case for a
	// worktree branch, so its refusal escalates like the directory's.
	if opts.DeleteBranch {
		if branch == "" {
			set(StepDeleteBranch, StatusSkipped, "no branch recorded for this worktree")
			return res
		}
		err := gitutil.DeleteBranch(repoRoot, branch, opts.ForceBranch)
		var needsForce *gitutil.ErrNeedsForce
		switch {
		case err == nil:
			set(StepDeleteBranch, StatusDone, branch)
		case errors.As(err, &needsForce):
			set(StepDeleteBranch, StatusNeedsForce, needsForce.GitOutput)
			res.NeedsForce = StepDeleteBranch
		default:
			set(StepDeleteBranch, StatusFailed, err.Error())
		}
	}
	return res
}

// resolve finds the repo root, repo name and branch for a worktree.
//
// The registry comes first because it still answers after the directory is
// gone — which is the state every force retry is in. Inspecting the directory
// is the fallback for a worktree that was never registered.
func resolve(conn *sql.DB, path string) (repoRoot, repo, branch string, err error) {
	if e, gErr := registry.Get(conn, path); gErr == nil && e != nil {
		return e.RepoRoot, e.Repo, e.Branch, nil
	}
	root, rErr := gitutil.RepoRoot(path)
	if rErr != nil || root == "" {
		return "", "", "", fmt.Errorf("%s is neither a registered worktree nor a readable git worktree", path)
	}
	return root, filepath.Base(root), "", nil
}
```

Add the missing import to the test file's header (`"database/sql"`) if the compiler asks for it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/worktreedel/ -count=1 -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add internal/worktreedel/worktreedel.go internal/worktreedel/worktreedel_test.go
git commit --signoff -m "feat(worktreedel): shared worktree deletion runner

Extracts the deletion sequence so the CLI and the web UI share one copy. The
runner reports each step to an observer, which is what lets the CLI keep its
spinners while the HTTP handler collects a response.

Every run starts from the top — there is no session, because granting a force
re-posts the whole request — so steps tolerate work already done and report it
as skipped. A failing remove_directory aborts the run: unregistering a worktree
still on disk strands it, invisible to the tool but still holding its ports."
```

---

### Task 3: CLI drives the runner, and gains a branch prompt

**Files:**
- Modify: `cmd/delete.go` (replace the body of `runDelete`, :34-124)
- Test: `internal/worktreedel/worktreedel_test.go` covers the sequence; this task is verified by running the CLI.

**Interfaces:**
- Consumes: `worktreedel.Run`, `worktreedel.Options`, `worktreedel.Step`, `worktreedel.Status*`, `worktreedel.StepKey`, `ui.ConfirmDefault(prompt string, defaultYes bool) bool` (existing, `internal/ui/ui.go:42`)
- Produces: `--delete-branch` flag on `worktree delete`

- [ ] **Step 1: Replace `runDelete`**

In `cmd/delete.go`, add the flag in `init()`:

```go
var deleteBranchFlag bool

func init() {
	deleteCmd.Flags().BoolVar(&deleteForce, "force", false, "Skip confirmation")
	deleteCmd.Flags().BoolVar(&deleteBranchFlag, "delete-branch", false,
		"Also delete the worktree's branch")
	rootCmd.AddCommand(deleteCmd)
}
```

Replace the body of `runDelete` after the existing confirmation block with a driver over the runner:

```go
	// Branch deletion is opt-in and defaults to NO. Removing a worktree
	// destroys no work; deleting an unmerged branch can, so it must never
	// happen to someone holding down enter. --force skips the confirmation
	// for the worktree, not the branch; --delete-branch is the scriptable way.
	deleteBranch := deleteBranchFlag
	if !deleteBranch && !deleteForce {
		if b := gitBranch(wtPath); b != "" {
			deleteBranch = ui.ConfirmDefault(
				fmt.Sprintf("Delete the branch %q too?", b), false)
		}
	}

Then drive the runner, printing each step as the observer reports it. Note
that `ui.SpinWhile` is deliberately NOT used here: it takes a `func() error`,
which cannot carry per-step reporting, and the observer already gives finer
progress than one spinner could.

```go
	opts := worktreedel.Options{Path: wtPath, DeleteBranch: deleteBranch}
	for {
		res := worktreedel.Run(conn, cfg, opts, func(s worktreedel.Step) {
			switch s.Status {
			case worktreedel.StatusDone:
				fmt.Printf("%s %s\n", ui.Green("✓"), s.Label)
			case worktreedel.StatusSkipped:
				fmt.Printf("%s %s (%s)\n", ui.Green("✓"), s.Label, s.Detail)
			case worktreedel.StatusFailed:
				fmt.Fprintf(os.Stderr, "Warning: %s: %s\n", s.Label, s.Detail)
			}
		})
		if res.Err != nil {
			return res.Err
		}
		if res.NeedsForce == "" {
			return nil
		}
		step := stepByKey(res, res.NeedsForce)
		fmt.Printf("\n%s %s:\n  %s\n\n", ui.Yellow("!"), step.Label, step.Detail)
		if res.NeedsForce == worktreedel.StepRemoveDirectory {
			fmt.Println("This is usually leftover build output or read-only files in the worktree.")
			if !ui.Confirm("Force-remove the directory (fix permissions and delete)?") {
				fmt.Printf("\nLeaving the worktree in place. To remove it manually:\n")
				fmt.Printf("  rm -rf %s\n  git -C %s worktree prune\n  worktree cleanup\n", wtPath, repoRoot)
				return nil
			}
			opts.ForceDirectory = true
			continue
		}
		if !ui.Confirm("Force-delete the branch (discards unmerged commits)?") {
			fmt.Println("Leaving the branch in place.")
			return nil
		}
		opts.ForceBranch = true
	}
}

func stepByKey(res worktreedel.Result, key worktreedel.StepKey) worktreedel.Step {
	for _, s := range res.Steps {
		if s.Key == key {
			return s
		}
	}
	return worktreedel.Step{}
}
```

Delete the now-unused inline cleanup (ports/registry/resources/kubeconfig/prune) and any imports it alone used (`env`, `ports`, `registry`, `resources`, `errors`).

- [ ] **Step 2: Build and vet**

Run: `go build ./... && go vet ./cmd/`
Expected: no output

- [ ] **Step 3: Exercise the CLI end to end**

```bash
go run . add --help >/dev/null   # sanity: the binary still builds its commands
go test ./... -count=1
```
Expected: PASS

- [ ] **Step 4: Manual smoke test**

```bash
go build -o /tmp/wt-test . && /tmp/wt-test delete --help
```
Expected: help lists both `--force` and `--delete-branch`.

- [ ] **Step 5: Commit**

```bash
git add cmd/delete.go
git commit --signoff -m "refactor(cli): drive worktree deletion through the shared runner

runDelete keeps its output but no longer owns the sequence, so the CLI and the
web UI cannot drift apart.

Adds a branch prompt defaulting to NO, plus --delete-branch for scripts.
Removing a worktree destroys no work; deleting an unmerged branch can, so it
must never happen to someone holding down enter. --force skips the worktree
confirmation, not the branch one."
```

---

### Task 4: `POST /api/worktrees/delete`

**Files:**
- Create: `internal/webui/worktree_delete_api.go`
- Modify: `internal/webui/server.go` (register the route beside the other POSTs)
- Test: `internal/webui/worktree_delete_api_test.go`

**Interfaces:**
- Consumes: `worktreedel.Run`, `worktreedel.Options`, `worktreedel.Result`, `config.Load`, `writeJSON`, `writeError`
- Produces: `POST /api/worktrees/delete` accepting `{path, delete_branch, force_directory, force_branch}` and returning `{ok, needs_force, steps[]}`

- [ ] **Step 1: Write the failing tests**

Create `internal/webui/worktree_delete_api_test.go`:

```go
package webui

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
)

func deleteFixture(t *testing.T) (*Server, string) {
	t.Helper()
	base := t.TempDir()
	repoRoot := filepath.Join(base, "repo")
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

	wtPath := filepath.Join(base, "worktrees", "wt-1")
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
	return &Server{DB: conn}, wtPath
}

func postDelete(t *testing.T, ts *httptest.Server, body map[string]any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(ts.URL+"/api/worktrees/delete", "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestDeleteWorktreeReportsEveryStep(t *testing.T) {
	srv, wtPath := deleteFixture(t)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	code, body := postDelete(t, ts, map[string]any{"path": wtPath})
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200", code)
	}
	if body["ok"] != true {
		t.Fatalf("ok = %v, body = %+v", body["ok"], body)
	}
	steps, _ := body["steps"].([]any)
	if len(steps) < 6 {
		t.Fatalf("want a step per stage for the stepper, got %d: %+v", len(steps), steps)
	}
	first, _ := steps[0].(map[string]any)
	// The stepper renders these directly, so both must be present.
	if first["key"] == nil || first["label"] == nil {
		t.Fatalf("step is missing key/label: %+v", first)
	}
	if _, err := os.Stat(wtPath); !os.IsNotExist(err) {
		t.Fatal("worktree directory still present")
	}
}

// The distinction the whole flow rests on: "git wants confirmation" must not
// look like "the delete broke".
func TestDeleteWorktreeNeedsForceIsTwoHundred(t *testing.T) {
	srv, wtPath := deleteFixture(t)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// An unmerged commit on the branch makes `git branch -d` refuse.
	os.WriteFile(filepath.Join(wtPath, "b.txt"), []byte("two\n"), 0o644)
	for _, args := range [][]string{{"add", "b.txt"}, {"commit", "-m", "unmerged"}} {
		cmd := exec.Command("git", append([]string{"-C", wtPath}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		cmd.Run()
	}

	code, body := postDelete(t, ts, map[string]any{"path": wtPath, "delete_branch": true})
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — needs_force is not an error", code)
	}
	if body["needs_force"] != "delete_branch" {
		t.Fatalf("needs_force = %v, want delete_branch", body["needs_force"])
	}

	code, body = postDelete(t, ts, map[string]any{
		"path": wtPath, "delete_branch": true, "force_branch": true,
	})
	if code != http.StatusOK || body["needs_force"] != "" {
		t.Fatalf("forced retry: status %d body %+v", code, body)
	}
}

func TestDeleteWorktreeRequiresPath(t *testing.T) {
	srv, _ := deleteFixture(t)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	if code, _ := postDelete(t, ts, map[string]any{}); code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", code)
	}
}

func TestDeleteWorktreeUnknownPath(t *testing.T) {
	srv, _ := deleteFixture(t)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	code, body := postDelete(t, ts, map[string]any{"path": filepath.Join(t.TempDir(), "nope")})
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200 with ok:false", code)
	}
	if body["ok"] != false {
		t.Fatalf("ok = %v, want false for a worktree that cannot be resolved", body["ok"])
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/webui/ -run TestDeleteWorktree -count=1`
Expected: FAIL — 404 from the mux (route not registered)

- [ ] **Step 3: Implement the handler**

Create `internal/webui/worktree_delete_api.go`:

```go
package webui

import (
	"encoding/json"
	"net/http"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/worktreedel"
)

type deleteWorktreeRequest struct {
	Path           string `json:"path"`
	DeleteBranch   bool   `json:"delete_branch"`
	ForceDirectory bool   `json:"force_directory"`
	ForceBranch    bool   `json:"force_branch"`
}

type deleteWorktreeResponse struct {
	OK         bool                 `json:"ok"`
	NeedsForce worktreedel.StepKey  `json:"needs_force"`
	Steps      []worktreedel.Step   `json:"steps"`
	Error      string               `json:"error,omitempty"`
}

// handleDeleteWorktree: POST /api/worktrees/delete
//
// needs_force comes back as 200 with a marker, never an error status: "git
// wants confirmation" and "the delete broke" are the one distinction the whole
// flow rests on, and an error status would collapse them. A hard failure is
// also 200 with ok:false, so the modal can render the partial step list rather
// than replacing it with an error page.
func (s *Server) handleDeleteWorktree(w http.ResponseWriter, r *http.Request) {
	var req deleteWorktreeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	cfg, err := config.Load()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	res := worktreedel.Run(s.DB, cfg, worktreedel.Options{
		Path:           req.Path,
		DeleteBranch:   req.DeleteBranch,
		ForceDirectory: req.ForceDirectory,
		ForceBranch:    req.ForceBranch,
	}, nil)

	out := deleteWorktreeResponse{
		OK:         res.Err == nil && res.NeedsForce == "",
		NeedsForce: res.NeedsForce,
		Steps:      res.Steps,
	}
	if res.Err != nil {
		out.Error = res.Err.Error()
	}
	writeJSON(w, http.StatusOK, out)
}
```

In `internal/webui/server.go`, register beside the existing POST routes:

```go
	mux.HandleFunc("POST /api/worktrees/delete", s.handleDeleteWorktree)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/webui/ -count=1`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/webui/worktree_delete_api.go internal/webui/worktree_delete_api_test.go internal/webui/server.go
git commit --signoff -m "feat(webui): POST /api/worktrees/delete

Returns per-step outcomes so the modal can render a pipeline stepper rather
than a single spinner, and so partial failures stay visible.

needs_force is a 200 with a marker, never an error status: 'git wants
confirmation' and 'the delete broke' are the one distinction the flow rests on.
A hard failure is likewise 200 with ok:false, so the modal keeps the partial
step list instead of replacing it with an error page."
```

---

### Task 5: Delete modal — confirm, stepper, escalation, summary

**Files:**
- Create: `ui/src/components/DeleteWorktreeModal.tsx`
- Create: `ui/src/components/DeleteWorktreeModal.test.tsx`
- Modify: `ui/src/api/client.ts` (add `deleteWorktree`)
- Modify: `ui/src/api/types.ts` (add `DeleteStep`, `DeleteWorktreeResponse`)

**Interfaces:**
- Consumes: `POST /api/worktrees/delete` (Task 4)
- Produces: `<DeleteWorktreeModal opened path name branch onClose onDeleted />`, `api.deleteWorktree(args)`

- [ ] **Step 1: Add the API types and client call**

In `ui/src/api/types.ts`:

```ts
export type DeleteStepStatus = "done" | "skipped" | "failed" | "needs_force" | "pending"
export interface DeleteStep {
  key: string
  label: string
  status: DeleteStepStatus
  detail?: string
}
export interface DeleteWorktreeResponse {
  ok: boolean
  /** "" when nothing is waiting; otherwise the step key needing a force. */
  needs_force: string
  steps: DeleteStep[]
  error?: string
}
```

In `ui/src/api/client.ts`:

```ts
  deleteWorktree: (args: {
    path: string
    delete_branch?: boolean
    force_directory?: boolean
    force_branch?: boolean
  }) =>
    fetchJSON<DeleteWorktreeResponse>("/api/worktrees/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
```

- [ ] **Step 2: Write the failing tests**

Create `ui/src/components/DeleteWorktreeModal.test.tsx`:

```tsx
import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { DeleteWorktreeModal } from "./DeleteWorktreeModal"
import type { DeleteWorktreeResponse } from "../api/types"

const deleteWorktree = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { api: { ...actual.api, deleteWorktree: (...a: unknown[]) => deleteWorktree(...a) } }
})

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)
afterEach(() => { cleanup(); deleteWorktree.mockReset() })

const modal = (over: Partial<React.ComponentProps<typeof DeleteWorktreeModal>> = {}) => (
  <DeleteWorktreeModal
    opened
    path="/wt/foo"
    name="foo"
    branch="feature"
    onClose={vi.fn()}
    onDeleted={vi.fn()}
    {...over}
  />
)

const ok = (over: Partial<DeleteWorktreeResponse> = {}): DeleteWorktreeResponse => ({
  ok: true,
  needs_force: "",
  steps: [
    { key: "remove_directory", label: "Remove worktree directory", status: "done" },
    { key: "release_ports", label: "Release port range", status: "done" },
  ],
  ...over,
})

describe("DeleteWorktreeModal", () => {
  it("keeps Delete disabled until the worktree name is typed exactly", async () => {
    const user = userEvent.setup()
    wrap(modal())
    const button = screen.getByRole("button", { name: /^delete$/i })
    expect(button).toBeDisabled()

    await user.type(screen.getByLabelText(/type the worktree name/i), "fo")
    expect(button).toBeDisabled()
    await user.type(screen.getByLabelText(/type the worktree name/i), "o")
    expect(button).toBeEnabled()
  })

  it("leaves the branch checkbox unchecked, and only sends delete_branch when ticked", async () => {
    const user = userEvent.setup()
    deleteWorktree.mockResolvedValue(ok())
    wrap(modal())

    const checkbox = screen.getByRole("checkbox", { name: /delete the branch/i })
    expect(checkbox).not.toBeChecked()

    await user.type(screen.getByLabelText(/type the worktree name/i), "foo")
    await user.click(screen.getByRole("button", { name: /^delete$/i }))
    await waitFor(() => expect(deleteWorktree).toHaveBeenCalled())
    expect(deleteWorktree.mock.calls[0][0]).toMatchObject({ path: "/wt/foo", delete_branch: false })
  })

  it("renders a stage per step once the run reports", async () => {
    const user = userEvent.setup()
    deleteWorktree.mockResolvedValue(ok())
    wrap(modal())
    await user.type(screen.getByLabelText(/type the worktree name/i), "foo")
    await user.click(screen.getByRole("button", { name: /^delete$/i }))

    expect(await screen.findByText("Remove worktree directory")).toBeInTheDocument()
    expect(screen.getByText("Release port range")).toBeInTheDocument()
  })

  it("offers Force under the failed stage, and re-posts with the matching flag", async () => {
    const user = userEvent.setup()
    deleteWorktree
      .mockResolvedValueOnce({
        ok: false,
        needs_force: "remove_directory",
        steps: [{
          key: "remove_directory", label: "Remove worktree directory",
          status: "needs_force", detail: "fatal: could not remove",
        }],
      } as DeleteWorktreeResponse)
      .mockResolvedValueOnce(ok())
    wrap(modal())
    await user.type(screen.getByLabelText(/type the worktree name/i), "foo")
    await user.click(screen.getByRole("button", { name: /^delete$/i }))

    // git's own words are shown, not a generic message.
    expect(await screen.findByText(/could not remove/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /force/i }))

    await waitFor(() => expect(deleteWorktree).toHaveBeenCalledTimes(2))
    expect(deleteWorktree.mock.calls[1][0]).toMatchObject({ force_directory: true })
  })

  it("stays open on success and only navigates when OK is clicked", async () => {
    const user = userEvent.setup()
    const onDeleted = vi.fn()
    deleteWorktree.mockResolvedValue(ok())
    wrap(modal({ onDeleted }))
    await user.type(screen.getByLabelText(/type the worktree name/i), "foo")
    await user.click(screen.getByRole("button", { name: /^delete$/i }))

    // The summary is the only report the user gets — it must not vanish.
    expect(await screen.findByRole("button", { name: /^ok$/i })).toBeInTheDocument()
    expect(onDeleted).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: /^ok$/i }))
    expect(onDeleted).toHaveBeenCalled()
  })

  it("keeps the step list visible when the run fails outright", async () => {
    const user = userEvent.setup()
    deleteWorktree.mockResolvedValue({
      ok: false, needs_force: "", error: "not a worktree",
      steps: [{ key: "remove_directory", label: "Remove worktree directory", status: "failed", detail: "not a worktree" }],
    } as DeleteWorktreeResponse)
    wrap(modal())
    await user.type(screen.getByLabelText(/type the worktree name/i), "foo")
    await user.click(screen.getByRole("button", { name: /^delete$/i }))

    expect(await screen.findByText("Remove worktree directory")).toBeInTheDocument()
    expect(screen.getByText(/not a worktree/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ui && npx vitest run src/components/DeleteWorktreeModal.test.tsx`
Expected: FAIL — cannot resolve `./DeleteWorktreeModal`

- [ ] **Step 4: Implement the modal**

Create `ui/src/components/DeleteWorktreeModal.tsx`:

```tsx
import { useState } from "react"
import { Alert, Button, Checkbox, Group, Loader, Modal, Stack, Text, TextInput } from "@mantine/core"
import { IconCheck, IconX } from "@tabler/icons-react"
import { api } from "../api/client"
import type { DeleteStep, DeleteWorktreeResponse } from "../api/types"

/** One stage of the pipeline: icon, label, and git's words when there are any. */
function StepRow({ step, running }: { step: DeleteStep; running: boolean }) {
  const icon = running ? <Loader size={14} />
    : step.status === "failed" || step.status === "needs_force"
      ? <IconX size={14} color="var(--mantine-color-red-5)" />
      : step.status === "pending"
        ? <Text size="xs" c="dimmed">○</Text>
        : <IconCheck size={14} color="var(--mantine-color-green-5)" />
  return (
    <Stack gap={2}>
      <Group gap={8} wrap="nowrap">
        {icon}
        <Text size="sm" c={step.status === "pending" ? "dimmed" : undefined}>{step.label}</Text>
        {step.status === "skipped" && step.detail && (
          <Text size="xs" c="dimmed">({step.detail})</Text>
        )}
      </Group>
      {(step.status === "failed" || step.status === "needs_force") && step.detail && (
        <Text size="xs" c="red" pl={22} style={{ whiteSpace: "pre-wrap" }}>{step.detail}</Text>
      )}
    </Stack>
  )
}

/**
 * Deleting a worktree, with the same care the CLI takes.
 *
 * The flow is deliberately multi-phase: git may refuse to remove the directory
 * (leftover build output, read-only files) and may refuse to delete an unmerged
 * branch. Each refusal comes back as needs_force naming the step, and the
 * prompt appears BENEATH that stage so the completed stages stay visible while
 * the user decides.
 *
 * On success the modal stays open. The summary is the only report of what
 * happened — which ports were freed, what was skipped — so closing
 * automatically would throw it away.
 */
export function DeleteWorktreeModal({ opened, path, name, branch, onClose, onDeleted }: {
  opened: boolean
  path: string
  name: string
  branch?: string
  onClose: () => void
  /** Called when the user acknowledges a completed delete. */
  onDeleted: () => void
}) {
  const [typed, setTyped] = useState("")
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<DeleteWorktreeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (force: { force_directory?: boolean; force_branch?: boolean } = {}) => {
    setRunning(true)
    setError(null)
    try {
      setResult(await api.deleteWorktree({ path, delete_branch: deleteBranch, ...force }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const needsForce = result?.needs_force ?? ""
  const finished = Boolean(result && !needsForce && result.ok)

  return (
    <Modal opened={opened} onClose={onClose} title={`Delete worktree ${name}`} size="lg">
      <Stack gap="sm">
        {!result && (
          <>
            <Text size="sm">
              This removes the worktree directory and everything worktree tracks for it —
              its port range, tracked resources and kubeconfig.
            </Text>
            <TextInput
              label={`Type the worktree name (${name}) to confirm`}
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
            />
            <Checkbox
              label={branch ? `Also delete the branch ${branch}` : "Also delete the branch"}
              checked={deleteBranch}
              onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
            />
          </>
        )}

        {result && (
          <Stack gap={6}>
            {result.steps.map((s) => (
              <StepRow key={s.key} step={s} running={running && s.status === "pending"} />
            ))}
          </Stack>
        )}

        {error && <Alert color="red" variant="light">{error}</Alert>}
        {result?.error && !needsForce && <Alert color="red" variant="light">{result.error}</Alert>}

        {needsForce === "remove_directory" && (
          <Alert color="yellow" variant="light">
            <Text size="sm">
              This is usually leftover build output or read-only files in the worktree.
            </Text>
          </Alert>
        )}

        <Group justify="flex-end">
          {!result && (
            <>
              <Button variant="default" onClick={onClose}>Cancel</Button>
              <Button
                color="red"
                disabled={typed !== name || running}
                loading={running}
                onClick={() => void run()}
              >
                Delete
              </Button>
            </>
          )}
          {needsForce && (
            <>
              <Button variant="default" onClick={onClose} disabled={running}>Cancel</Button>
              <Button
                color="red"
                loading={running}
                onClick={() =>
                  void run(needsForce === "remove_directory"
                    ? { force_directory: true }
                    : { force_branch: true })}
              >
                {needsForce === "remove_directory"
                  ? "Force-remove the directory"
                  : "Force-delete the branch"}
              </Button>
            </>
          )}
          {result && !needsForce && (
            <Button onClick={finished ? onDeleted : onClose}>OK</Button>
          )}
        </Group>
      </Stack>
    </Modal>
  )
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd ui && npx tsc --noEmit && npx vitest run src/components/DeleteWorktreeModal.test.tsx`
Expected: PASS (6 tests), no type errors

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/DeleteWorktreeModal.tsx ui/src/components/DeleteWorktreeModal.test.tsx ui/src/api/client.ts ui/src/api/types.ts
git commit --signoff -m "feat(ui): delete-worktree modal with a pipeline stepper

Typed-name confirmation, an unchecked-by-default branch checkbox, and a stage
per step driven straight from the server's report.

A needs_force stage shows git's own words with the Force prompt beneath it, so
the completed stages stay visible while deciding. On success the modal stays
open: the summary is the only report of what happened, so closing itself would
throw it away."
```

---

### Task 6: Trash control on the worktree detail card

**Files:**
- Modify: `ui/src/components/WorktreeDetailCard.tsx`
- Modify: `ui/src/components/WorktreeDetailCard.test.tsx`

**Interfaces:**
- Consumes: `<DeleteWorktreeModal>` (Task 5), `useLocation` from wouter, `useQueryClient` from `@tanstack/react-query`
- Produces: nothing downstream

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/components/WorktreeDetailCard.test.tsx`:

```tsx
describe("delete control", () => {
  it("opens the delete modal from the trash control", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await user.click(await screen.findByRole("button", { name: /delete worktree/i }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    // The typed-name confirmation is the safeguard; it must be present.
    expect(screen.getByLabelText(/type the worktree name/i)).toBeInTheDocument()
  })

  it("does not delete anything just by opening the modal", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await user.click(await screen.findByRole("button", { name: /delete worktree/i }))
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeDisabled()
  })
})
```

Add `import userEvent from "@testing-library/user-event"` to that file's imports if absent.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && npx vitest run src/components/WorktreeDetailCard.test.tsx`
Expected: FAIL — no button named "delete worktree"

- [ ] **Step 3: Implement**

In `ui/src/components/WorktreeDetailCard.tsx`, add the control to the name row and the modal alongside:

```tsx
  const [, navigate] = useLocation()
  const qc = useQueryClient()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const name = w.path.split("/").filter(Boolean).pop() || w.path
```

Replace the heading `Group` with one that reserves the right-hand side:

```tsx
        <Group gap="xs" wrap="nowrap" justify="space-between">
          <Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
            <Text fw={700} size="md" style={{ overflowWrap: "anywhere" }}>{name}</Text>
            {!w.on_disk && <Badge size="xs" color="red">missing</Badge>}
          </Group>
          <Tooltip label="Delete worktree">
            <ActionIcon
              variant="subtle"
              color="red"
              size="sm"
              aria-label="Delete worktree"
              onClick={() => setDeleteOpen(true)}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
```

And at the end of the `Paper`:

```tsx
      {deleteOpen && (
        <DeleteWorktreeModal
          opened
          path={w.path}
          name={name}
          branch={git?.branch || w.branch}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => {
            setDeleteOpen(false)
            // The worktree is gone; the list is the only place left to be.
            void qc.invalidateQueries({ queryKey: ["worktrees"] })
            navigate("/")
          }}
        />
      )}
```

Add the imports: `useState` from react, `ActionIcon`/`Tooltip` from `@mantine/core`, `IconTrash` from `@tabler/icons-react`, `useLocation` from `wouter`, `useQueryClient` from `@tanstack/react-query`, and `DeleteWorktreeModal`.

- [ ] **Step 4: Run the full UI suite**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: PASS, no type errors

- [ ] **Step 5: Full verification and commit**

```bash
go test ./... -count=1
cd ui && npx tsc --noEmit && npx vitest run && cd ..
git add ui/src/components/WorktreeDetailCard.tsx ui/src/components/WorktreeDetailCard.test.tsx
git commit --signoff -m "feat(ui): delete a worktree from its detail card

A red trash control beside the worktree name opens the delete modal. On
acknowledgement the worktree list is invalidated and the page returns home —
there is nothing left to show for a worktree that no longer exists."
```

---

### Task 7: Documentation

**Files:**
- Modify: `docs/web-ui-architecture.md` (route table and a note on the flow)
- Modify: `docs/ui-feature-roadmap.md` (Phase G → DONE)

- [ ] **Step 1: Add the route to the architecture doc**

In the route table:

```markdown
| POST | `/api/worktrees/delete` | body: `{path, delete_branch, force_directory, force_branch}` | `{ok, needs_force, steps[]}` |
```

And beneath it:

```markdown
**Deletion is multi-phase.** `internal/worktreedel` owns the sequence and both
the CLI and this endpoint drive it, so they cannot drift. git may refuse to
remove the directory, and may refuse to delete an unmerged branch; each refusal
returns **200** with `needs_force` naming the step, never an error status —
"git wants confirmation" and "the delete broke" must stay distinguishable.
There is no server-side session: granting a force re-posts the whole request,
so every step is idempotent and already-done work reports as `skipped`.
```

- [ ] **Step 2: Move Phase G to done in the roadmap**

Replace the Phase G body with a short summary of what shipped, keeping the
decisions that still constrain the code (needs_force as 200, the abort rule for
`remove_directory`, branch deletion opt-in on both surfaces).

- [ ] **Step 3: Commit**

```bash
git add docs/web-ui-architecture.md docs/ui-feature-roadmap.md
git commit --signoff -m "docs: record the worktree delete flow"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Shared runner extracted from `cmd/delete.go` | 2 |
| Observer callback serving CLI and web | 2, 3 |
| Idempotent, session-free retries | 2 (test), 4 |
| `needs_force` as 200 with marker | 4 (test) |
| `remove_directory` failure aborts | 2 (test) |
| Cleanup failures do not abort | 2 |
| `gitutil.DeleteBranch` reusing `ErrNeedsForce` | 1 |
| Repo root/branch from registry, directory fallback | 2 (`resolve`) |
| Trash control on the detail card | 6 |
| Typed-name confirmation | 5 (test) |
| Branch checkbox unchecked by default | 5 (test) |
| Pipeline stepper from `steps[]` | 5 |
| Force prompt beneath the failed stage | 5 (test) |
| Modal stays open on success; OK navigates | 5, 6 |
| CLI branch prompt defaulting to no | 3 |
| Unreachable worktree fails, registry intact | 2 (test), 4 (test) |

**Type consistency:** `StepKey` values are the same strings in Go
(`worktreedel`), on the wire, and in the TS `DeleteStep.key` checks
(`remove_directory`, `delete_branch`). `Options` field names match the JSON
request fields (`delete_branch`, `force_directory`, `force_branch`).

**Placeholder scan:** clean. An earlier draft of Task 3 carried two versions of
the CLI loop with a note about which to use; the abandoned one is removed, and
the reason `ui.SpinWhile` is not used is stated inline where the code is.
