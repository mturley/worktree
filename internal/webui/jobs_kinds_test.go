package webui

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/jobs"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/testgit"
	"github.com/mturley/worktree/internal/worktreedel"
	"github.com/mturley/worktree/internal/worktreenew"
)

// jobsTestDB is a migrated worktree DB of its own, so a test's jobs rows are
// nobody else's.
func jobsTestDB(t *testing.T) *Server {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return &Server{DB: conn}
}

// jobDeleteFixture is a registered linked worktree the delete kind can run
// against, from the shared template (no git spawns per test).
func jobDeleteFixture(t *testing.T) (*Server, string) {
	t.Helper()
	wt := testgit.Worktree(t)
	s := jobsTestDB(t)
	if err := registry.Register(s.DB, registry.Entry{
		Path: wt, Repo: "repo", RepoRoot: filepath.Join(filepath.Dir(wt), "repo"),
		Branch: "feature", CreatedAt: "2026-11-16T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}
	return s, wt
}

// commitInWorktree leaves an unmerged commit on the worktree's branch, which
// is what makes `git branch -d` refuse and the delete kind ask.
func commitInWorktree(t *testing.T, wt string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(wt, "b.txt"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "b.txt"}, {"commit", "-m", "unmerged"}} {
		cmd := exec.Command("git", append([]string{"-C", wt}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
}

func TestCreateAnswerTable(t *testing.T) {
	t.Parallel()
	answer := (&Server{}).createJobKind().Answer
	base := createWorktreeRequest{Input: "7", RepoRoot: "/r"}
	reuse := worktreenew.Confirm{Key: worktreenew.ConfirmReuseBranch, Branch: "b"}
	reset := worktreenew.Confirm{Key: worktreenew.ConfirmResetToPR, Branch: "b"}

	cases := []struct {
		name     string
		question worktreenew.Confirm
		yes      bool
		wantEnd  bool
		want     createWorktreeRequest
	}{
		{"reuse yes", reuse, true, false,
			createWorktreeRequest{Input: "7", RepoRoot: "/r", ReuseBranch: true}},
		// Declining to reuse the branch ends the job: there is nothing else
		// the create could do with it.
		{"reuse no", reuse, false, true, createWorktreeRequest{}},
		{"reset yes", reset, true, false,
			createWorktreeRequest{Input: "7", RepoRoot: "/r", ReuseBranch: true, ResetToPR: true}},
		// Declining the reset must carry decline_reset, or the replay asks
		// the same question forever.
		{"reset no", reset, false, false,
			createWorktreeRequest{Input: "7", RepoRoot: "/r", ReuseBranch: true, DeclineReset: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			next, end, err := answer(
				json.RawMessage(mustJSON(t, base)), json.RawMessage(mustJSON(t, tc.question)), tc.yes)
			if err != nil {
				t.Fatal(err)
			}
			if end != tc.wantEnd {
				t.Fatalf("end = %v, want %v", end, tc.wantEnd)
			}
			if end {
				return
			}
			var got createWorktreeRequest
			if err := json.Unmarshal(next, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("next = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestDeleteAnswerTable(t *testing.T) {
	t.Parallel()
	answer := (&Server{}).deleteJobKind().Answer
	dir := map[string]any{"key": worktreedel.StepRemoveDirectory}
	branch := map[string]any{"key": worktreedel.StepDeleteBranch}

	cases := []struct {
		name     string
		base     deleteWorktreeRequest
		question map[string]any
		yes      bool
		wantEnd  bool
		want     deleteWorktreeRequest
	}{
		{"directory yes", deleteWorktreeRequest{Path: "/p"}, dir, true, false,
			deleteWorktreeRequest{Path: "/p", ForceDirectory: true}},
		// Declining the directory force ends the job: nothing may be
		// unregistered while its directory is still on disk.
		{"directory no", deleteWorktreeRequest{Path: "/p"}, dir, false, true,
			deleteWorktreeRequest{}},
		{"branch yes", deleteWorktreeRequest{Path: "/p", DeleteBranch: true}, branch, true, false,
			deleteWorktreeRequest{Path: "/p", DeleteBranch: true, ForceBranch: true}},
		// Declining the branch force is a replay without the branch delete,
		// not an end: the rest of the cleanup still has to complete.
		{"branch no", deleteWorktreeRequest{Path: "/p", DeleteBranch: true}, branch, false, false,
			deleteWorktreeRequest{Path: "/p"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			next, end, err := answer(
				json.RawMessage(mustJSON(t, tc.base)), json.RawMessage(mustJSON(t, tc.question)), tc.yes)
			if err != nil {
				t.Fatal(err)
			}
			if end != tc.wantEnd {
				t.Fatalf("end = %v, want %v", end, tc.wantEnd)
			}
			if end {
				return
			}
			var got deleteWorktreeRequest
			if err := json.Unmarshal(next, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("next = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestDeleteKindRunsToSuccess(t *testing.T) {
	t.Parallel()
	s, wt := jobDeleteFixture(t)
	k := s.deleteJobKind()

	var reports []jobs.Step
	out := k.Run(json.RawMessage(mustJSON(t, deleteWorktreeRequest{Path: wt})),
		func(st jobs.Step) { reports = append(reports, st) })

	if out.State != jobs.StateSucceeded {
		t.Fatalf("state = %s (error %q), want succeeded", out.State, out.Error)
	}
	// The runner announces a step before doing its work; that announcement is
	// what the job shows as `running`.
	var statuses []jobs.StepStatus
	for _, st := range reports {
		if st.Key == string(worktreedel.StepRemoveDirectory) {
			statuses = append(statuses, st.Status)
		}
	}
	if len(statuses) < 2 || statuses[0] != jobs.StepRunning || statuses[len(statuses)-1] != jobs.StepDone {
		t.Fatalf("remove_directory statuses = %v, want running … done", statuses)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatal("worktree directory still present")
	}
}

func TestDeleteKindDeclineBranchForceCompletes(t *testing.T) {
	t.Parallel()
	s, wt := jobDeleteFixture(t)
	commitInWorktree(t, wt)
	k := s.deleteJobKind()

	out := k.Run(json.RawMessage(mustJSON(t,
		deleteWorktreeRequest{Path: wt, DeleteBranch: true})), func(jobs.Step) {})
	if out.State != jobs.StateNeedsAnswer {
		t.Fatalf("state = %s (error %q), want needs_answer", out.State, out.Error)
	}
	var q struct {
		Key worktreedel.StepKey `json:"key"`
	}
	if err := json.Unmarshal(out.Question, &q); err != nil {
		t.Fatal(err)
	}
	if q.Key != worktreedel.StepDeleteBranch {
		t.Fatalf("question key = %q, want delete_branch", q.Key)
	}

	next, end, err := k.Answer(
		json.RawMessage(mustJSON(t, deleteWorktreeRequest{Path: wt, DeleteBranch: true})),
		out.Question, false)
	if err != nil || end {
		t.Fatalf("answer(no): end = %v, err = %v", end, err)
	}
	again := k.Run(next, func(jobs.Step) {})
	if again.State != jobs.StateSucceeded {
		t.Fatalf("replay state = %s (error %q), want succeeded", again.State, again.Error)
	}
	if e, err := registry.Get(s.DB, wt); err != nil || e != nil {
		t.Fatalf("registry row survived declining the branch force: %+v (err %v)", e, err)
	}
}

// A delete whose directory removal worked but whose DB cleanup did not is a
// failed job, not a succeeded one: res.Err is nil, so only the step statuses
// say so.
func TestDeleteKindFailedStepFailsTheJob(t *testing.T) {
	t.Parallel()
	s, wt := jobDeleteFixture(t)
	req := json.RawMessage(mustJSON(t, deleteWorktreeRequest{Path: wt}))
	k := s.deleteJobKind()
	// Closing the DB leaves remove_directory (a plain filesystem op) working
	// while every DB-backed cleanup step fails.
	if err := s.DB.Close(); err != nil {
		t.Fatal(err)
	}

	out := k.Run(req, func(jobs.Step) {})
	if out.State != jobs.StateFailed {
		t.Fatalf("state = %s, want failed when a cleanup step failed", out.State)
	}
}

func TestCreateKindSucceedsWithResult(t *testing.T) {
	t.Parallel()
	wt := testgit.Worktree(t)
	s := jobsTestDB(t)
	repoRoot := filepath.Join(filepath.Dir(wt), "repo")
	k := s.createJobKind()

	// A branch name no other test in this package creates: every create lands
	// under the one test HOME.
	const branch = "job-kind-create"
	out := k.Run(json.RawMessage(mustJSON(t,
		createWorktreeRequest{Input: branch, RepoRoot: repoRoot})), func(jobs.Step) {})
	if out.State != jobs.StateSucceeded {
		t.Fatalf("state = %s (error %q), want succeeded", out.State, out.Error)
	}
	var res struct {
		Path   string `json:"path"`
		Branch string `json:"branch"`
	}
	if err := json.Unmarshal(out.Result, &res); err != nil {
		t.Fatal(err)
	}
	if res.Branch != branch {
		t.Fatalf("result branch = %q, want %q", res.Branch, branch)
	}
	if info, err := os.Stat(res.Path); err != nil || !info.IsDir() {
		t.Fatalf("result path %q is not a directory: %v", res.Path, err)
	}
}

func TestCreateKindBadRepoRootFails(t *testing.T) {
	t.Parallel()
	s := jobsTestDB(t)
	out := s.createJobKind().Run(json.RawMessage(mustJSON(t, createWorktreeRequest{
		Input: "job-kind-bad-root", RepoRoot: filepath.Join(t.TempDir(), "nope"),
	})), func(jobs.Step) {})

	if out.State != jobs.StateFailed {
		t.Fatalf("state = %s, want failed", out.State)
	}
	if !strings.Contains(out.Error, "repo root not found") {
		t.Fatalf("error = %q, want it to name the missing repo root", out.Error)
	}
}
