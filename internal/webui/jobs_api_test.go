package webui

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/jobs"
	"github.com/mturley/worktree/internal/testgit"
)

// jobsServer is a job-capable server whose clean successes do not expire
// while the test is reading them.
func jobsServer(t *testing.T, s *Server) *httptest.Server {
	t.Helper()
	s.jobs().SuccessTTL = time.Hour
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func postJob(t *testing.T, ts *httptest.Server, path string, body any) (int, map[string]any) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.Post(ts.URL+path, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// listJobs is GET /api/jobs.
func listJobs(t *testing.T, ts *httptest.Server) []map[string]any {
	t.Helper()
	resp, err := http.Get(ts.URL + "/api/jobs")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/jobs: status %d", resp.StatusCode)
	}
	var out struct {
		Jobs []map[string]any `json:"jobs"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Jobs == nil {
		t.Fatal("jobs = null, want an array")
	}
	return out.Jobs
}

func startedJob(t *testing.T, body map[string]any) map[string]any {
	t.Helper()
	job, ok := body["job"].(map[string]any)
	if !ok {
		t.Fatalf("response has no job: %+v", body)
	}
	return job
}

// blockingJobKind parks its run until release is closed, so a test can hold a
// job in `running`.
func blockingJobKind(name string, release <-chan struct{}) jobs.Kind {
	return jobs.Kind{
		Name: name,
		Plan: func(json.RawMessage) []jobs.Step { return nil },
		Run: func(json.RawMessage, func(jobs.Step)) jobs.Outcome {
			<-release
			return jobs.Outcome{State: jobs.StateSucceeded}
		},
	}
}

// fixedJobKind ends every run the same way.
func fixedJobKind(name string, out jobs.Outcome) jobs.Kind {
	return jobs.Kind{
		Name: name,
		Plan: func(json.RawMessage) []jobs.Step { return nil },
		Run:  func(json.RawMessage, func(jobs.Step)) jobs.Outcome { return out },
	}
}

func TestCreateWorktreeStartsJob(t *testing.T) {
	t.Parallel()
	wt := testgit.Worktree(t)
	srv := jobsTestDB(t)
	ts := jobsServer(t, srv)

	// A branch name no other test in this package creates: every create lands
	// under the one test HOME.
	const branch = "job-api-create"
	code, body := postJob(t, ts, "/api/worktrees/create", map[string]any{
		"input": branch, "repo_root": filepath.Join(filepath.Dir(wt), "repo"),
	})
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %+v", code, body)
	}
	if body["attached"] != false {
		t.Fatalf("attached = %v, want false for a fresh job", body["attached"])
	}
	job := startedJob(t, body)
	if job["kind"] != jobKindCreate {
		t.Fatalf("kind = %v, want %s", job["kind"], jobKindCreate)
	}
	// The response is written while the job runs, so it is either still
	// running or (on a fast machine) already done — never unset.
	if job["state"] != string(jobs.StateRunning) && job["state"] != string(jobs.StateSucceeded) {
		t.Fatalf("state = %v, want running or succeeded", job["state"])
	}
	if id, _ := job["id"].(string); id == "" {
		t.Fatalf("job has no id: %+v", job)
	}

	srv.jobs().Wait()
	list := listJobs(t, ts)
	if len(list) != 1 {
		t.Fatalf("jobs = %+v, want the one create", list)
	}
	if list[0]["state"] != string(jobs.StateSucceeded) {
		t.Fatalf("state = %v (error %v), want succeeded", list[0]["state"], list[0]["error"])
	}
	result, _ := list[0]["result"].(map[string]any)
	path, _ := result["path"].(string)
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		t.Fatalf("result path %q is not a directory: %v", path, err)
	}
}

func TestCreateWorktreeValidationStill400(t *testing.T) {
	t.Parallel()
	wt := testgit.Worktree(t)
	srv := jobsTestDB(t)
	ts := jobsServer(t, srv)

	for _, body := range []map[string]any{
		{"repo_root": "/r"},
		{"input": "x"},
		{"input": "https://x.slack.com/archives/C123/p1700000000000200", "repo_root": "/r"},
		{"input": wt, "repo_root": "/r"},
	} {
		code, got := postJob(t, ts, "/api/worktrees/create", body)
		if code != http.StatusBadRequest {
			t.Fatalf("body %+v: status = %d, want 400 (%+v)", body, code, got)
		}
	}
	if list := listJobs(t, ts); len(list) != 0 {
		t.Fatalf("a rejected request started jobs: %+v", list)
	}
}

func TestDeleteWorktreeStartsJob(t *testing.T) {
	t.Parallel()
	srv, wt := jobDeleteFixture(t)
	ts := jobsServer(t, srv)

	code, body := postJob(t, ts, "/api/worktrees/delete", map[string]any{"path": wt})
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %+v", code, body)
	}
	job := startedJob(t, body)
	if job["kind"] != jobKindDelete {
		t.Fatalf("kind = %v, want %s", job["kind"], jobKindDelete)
	}

	srv.jobs().Wait()
	list := listJobs(t, ts)
	if len(list) != 1 || list[0]["state"] != string(jobs.StateSucceeded) {
		t.Fatalf("jobs = %+v, want one succeeded delete", list)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatal("worktree directory still present")
	}
}

func TestDeleteTwiceAttaches(t *testing.T) {
	t.Parallel()
	srv, wt := jobDeleteFixture(t)
	release := make(chan struct{})
	// The real delete would finish before the second request arrives; this
	// one holds the job open so the attach is what is being tested.
	srv.jobs().Register(blockingJobKind(jobKindDelete, release))
	ts := jobsServer(t, srv)
	defer func() {
		close(release)
		srv.jobs().Wait()
	}()

	_, first := postJob(t, ts, "/api/worktrees/delete", map[string]any{"path": wt})
	_, second := postJob(t, ts, "/api/worktrees/delete", map[string]any{"path": wt})

	firstJob, secondJob := startedJob(t, first), startedJob(t, second)
	if firstJob["id"] != secondJob["id"] {
		t.Fatalf("ids %v and %v differ, want the same job", firstJob["id"], secondJob["id"])
	}
	if first["attached"] != false || second["attached"] != true {
		t.Fatalf("attached = %v then %v, want false then true", first["attached"], second["attached"])
	}
}

func TestJobAnswerConflict(t *testing.T) {
	t.Parallel()
	srv := jobsTestDB(t)
	release := make(chan struct{})
	srv.jobs().Register(blockingJobKind("test_block", release))
	ts := jobsServer(t, srv)
	defer func() {
		close(release)
		srv.jobs().Wait()
	}()

	job, _, err := srv.jobs().Start("test_block", "blocked", "t", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}

	if code, _ := postJob(t, ts, "/api/jobs/answer",
		map[string]any{"id": job.ID, "answer": "yes"}); code != http.StatusConflict {
		t.Fatalf("answering a running job: status = %d, want 409", code)
	}
	if code, _ := postJob(t, ts, "/api/jobs/answer",
		map[string]any{"id": job.ID, "answer": "maybe"}); code != http.StatusBadRequest {
		t.Fatalf("answer \"maybe\": status = %d, want 400", code)
	}
	if code, _ := postJob(t, ts, "/api/jobs/answer",
		map[string]any{"id": "nosuchjob", "answer": "yes"}); code != http.StatusNotFound {
		t.Fatalf("unknown id: status = %d, want 404", code)
	}
}

func TestJobRetryAndDismissStates(t *testing.T) {
	t.Parallel()
	srv := jobsTestDB(t)
	release := make(chan struct{})
	srv.jobs().Register(blockingJobKind("test_block", release))
	srv.jobs().Register(fixedJobKind("test_fail", jobs.Outcome{State: jobs.StateFailed, Error: "nope"}))
	srv.jobs().Register(fixedJobKind("test_ok", jobs.Outcome{State: jobs.StateSucceeded}))
	ts := jobsServer(t, srv)
	defer func() {
		close(release)
		srv.jobs().Wait()
	}()

	// The two finishing jobs first, so Wait does not sit on the blocked one.
	failed, _, err := srv.jobs().Start("test_fail", "failed", "t2", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	succeeded, _, err := srv.jobs().Start("test_ok", "ok", "t3", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	srv.jobs().Wait()
	running, _, err := srv.jobs().Start("test_block", "blocked", "t1", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}

	if code, _ := postJob(t, ts, "/api/jobs/dismiss",
		map[string]any{"id": running.ID}); code != http.StatusConflict {
		t.Fatalf("dismissing a running job: status = %d, want 409", code)
	}
	if code, _ := postJob(t, ts, "/api/jobs/dismiss",
		map[string]any{"id": failed.ID}); code != http.StatusNoContent {
		t.Fatalf("dismissing a failed job: status = %d, want 204", code)
	}
	for _, j := range listJobs(t, ts) {
		if j["id"] == failed.ID {
			t.Fatalf("the dismissed job is still listed: %+v", j)
		}
	}
	if code, _ := postJob(t, ts, "/api/jobs/retry",
		map[string]any{"id": succeeded.ID}); code != http.StatusConflict {
		t.Fatalf("retrying a succeeded job: status = %d, want 409", code)
	}
}

func TestStreamSendsJobsSnapshotFirst(t *testing.T) {
	t.Parallel()
	srv := jobsTestDB(t)
	srv.jobs().Register(fixedJobKind("test_park", jobs.Outcome{
		State: jobs.StateNeedsAnswer, Question: json.RawMessage(`{"key":"delete_branch"}`),
	}))
	parked, _, err := srv.jobs().Start("test_park", "parked", "t1", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	srv.jobs().Wait()

	ts := httptest.NewServer(http.HandlerFunc(srv.handleStream))
	t.Cleanup(ts.Close)
	lines := streamLines(t, ts, "?listeners=0")

	snapshot := readEventData(t, lines, "event: jobs")
	if !strings.Contains(snapshot, parked.ID) || !strings.Contains(snapshot, `"jobs":[`) {
		t.Fatalf("jobs snapshot = %s, want it to list the parked job", snapshot)
	}

	later, _, err := srv.jobs().Start("test_park", "parked again", "t2", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	srv.jobs().Wait()
	for {
		data := readEventData(t, lines, "event: job")
		if strings.Contains(data, later.ID) {
			return
		}
	}
}

// readEventData reads lines until event, and returns the data line's payload.
func readEventData(t *testing.T, lines <-chan string, event string) string {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case l, ok := <-lines:
			if !ok {
				t.Fatalf("stream ended before %q", event)
			}
			if l != event {
				continue
			}
			data, ok := <-lines
			if !ok {
				t.Fatalf("stream ended after %q", event)
			}
			return strings.TrimPrefix(data, "data: ")
		case <-timeout:
			t.Fatalf("no %q event", event)
		}
	}
}
