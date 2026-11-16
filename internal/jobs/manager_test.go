package jobs

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
)

func newManager(t *testing.T) (*Manager, *sql.DB) {
	t.Helper()
	conn := openDB(t)
	return New(conn, os.Getpid()), conn
}

// readOnlyPair returns a writable connection to a fresh DB and a second,
// read-only one to the same file, so a test can make the manager's writes fail
// while its reads keep working.
func readOnlyPair(t *testing.T) (write, read *sql.DB) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "w.db")
	write, err := wdb.OpenAt(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = write.Close() })
	read, err = wdb.OpenReadAt(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = read.Close() })
	return write, read
}

// expectNoChange fails if anything is published within a short window.
func expectNoChange(t *testing.T, ch <-chan Job) {
	t.Helper()
	select {
	case j := <-ch:
		t.Fatalf("published %+v, want nothing", j)
	case <-time.After(50 * time.Millisecond):
	}
}

// fake is a job kind whose run is driven by the test: it reports the steps the
// test hands it, acknowledging each once the manager has processed it, and
// returns the outcome the test hands it.
type fake struct {
	name    string
	plan    []Step
	started chan json.RawMessage
	reports chan Step
	acks    chan struct{}
	outcome chan Outcome
	calls   atomic.Int32
	boom    bool
	answer  func(request, question json.RawMessage, yes bool) (json.RawMessage, bool, error)
}

func newFake(name string, plan ...Step) *fake {
	return &fake{
		name:    name,
		plan:    plan,
		started: make(chan json.RawMessage, 8),
		reports: make(chan Step, 128),
		acks:    make(chan struct{}, 128),
		outcome: make(chan Outcome, 8),
	}
}

func (f *fake) kind() Kind {
	return Kind{
		Name: f.name,
		Plan: func(json.RawMessage) []Step {
			return append([]Step(nil), f.plan...)
		},
		Run: func(request json.RawMessage, report func(Step)) Outcome {
			f.calls.Add(1)
			f.started <- request
			if f.boom {
				panic("boom")
			}
			for {
				select {
				case s := <-f.reports:
					report(s)
					f.acks <- struct{}{}
				case o := <-f.outcome:
					return o
				}
			}
		},
		Answer: f.answer,
	}
}

// step reports s from inside the run and waits for the manager to process it.
func (f *fake) step(t *testing.T, s Step) {
	t.Helper()
	f.reports <- s
	select {
	case <-f.acks:
	case <-time.After(2 * time.Second):
		t.Fatal("report was not processed")
	}
}

// startedWith returns the request the run was called with.
func (f *fake) startedWith(t *testing.T) json.RawMessage {
	t.Helper()
	select {
	case r := <-f.started:
		return r
	case <-time.After(2 * time.Second):
		t.Fatal("run was not called")
		return nil
	}
}

func plan2() []Step {
	return []Step{
		{Key: "a", Label: "A", Status: StepPending},
		{Key: "b", Label: "B", Status: StepPending},
	}
}

func nextJob(t *testing.T, ch <-chan Job) Job {
	t.Helper()
	select {
	case j, ok := <-ch:
		if !ok {
			t.Fatal("changes channel was closed")
		}
		return j
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for a job change")
		return Job{}
	}
}

// waitFor reads changes until the job with id reaches state.
func waitFor(t *testing.T, ch <-chan Job, id string, state State) Job {
	t.Helper()
	for {
		if j := nextJob(t, ch); j.ID == id && j.State == state {
			return j
		}
	}
}

func statuses(j Job) []StepStatus {
	out := make([]StepStatus, 0, len(j.Steps))
	for _, s := range j.Steps {
		out = append(out, s.Status)
	}
	return out
}

func mustLoad(t *testing.T, conn *sql.DB, id string) Job {
	t.Helper()
	j, err := load(conn, id)
	if err != nil {
		t.Fatalf("load %s: %v", id, err)
	}
	return j
}

// expect checks one change event's state and step statuses, and that the DB
// row matches it.
func expect(t *testing.T, conn *sql.DB, ch <-chan Job, state State, want ...StepStatus) Job {
	t.Helper()
	j := nextJob(t, ch)
	if j.State != state {
		t.Fatalf("state %q, want %q", j.State, state)
	}
	if got := statuses(j); !reflect.DeepEqual(got, want) {
		t.Fatalf("steps %v, want %v", got, want)
	}
	row := mustLoad(t, conn, j.ID)
	if row.State != j.State || !reflect.DeepEqual(row.Steps, j.Steps) {
		t.Fatalf("DB row %+v does not match event %+v", row, j)
	}
	return j
}

func TestStartRunsAndStreamsSteps(t *testing.T) {
	t.Parallel()
	m, conn := newManager(t)
	f := newFake("create", plan2()...)
	m.Register(f.kind())

	snapshot, changes, unsubscribe := m.Subscribe()
	defer unsubscribe()
	if len(snapshot) != 0 {
		t.Fatalf("snapshot %+v, want empty", snapshot)
	}

	job, attached, err := m.Start("create", "Create thing", "/t", json.RawMessage(`{"x":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if attached {
		t.Fatal("attached to a job that did not exist")
	}
	if len(job.ID) != 16 {
		t.Fatalf("id %q, want 16 hex characters", job.ID)
	}
	if got := string(f.startedWith(t)); got != `{"x":1}` {
		t.Fatalf("run got request %s", got)
	}

	expect(t, conn, changes, StateRunning, StepPending, StepPending)
	f.step(t, Step{Key: "a", Label: "A", Status: StepRunning})
	expect(t, conn, changes, StateRunning, StepRunning, StepPending)
	f.step(t, Step{Key: "a", Label: "A", Status: StepDone})
	expect(t, conn, changes, StateRunning, StepDone, StepPending)
	f.step(t, Step{Key: "b", Label: "B", Status: StepRunning})
	expect(t, conn, changes, StateRunning, StepDone, StepRunning)
	f.step(t, Step{Key: "b", Label: "B", Status: StepDone})
	expect(t, conn, changes, StateRunning, StepDone, StepDone)

	f.outcome <- Outcome{State: StateSucceeded, Result: json.RawMessage(`{"path":"/t"}`)}
	final := expect(t, conn, changes, StateSucceeded, StepDone, StepDone)
	if final.FinishedAt == "" {
		t.Error("finished_at not set")
	}
	if string(final.Result) != `{"path":"/t"}` {
		t.Errorf("result %s", final.Result)
	}
	m.Wait()
}

func TestRunResetsRunningStepsAtEnd(t *testing.T) {
	t.Parallel()
	m, conn := newManager(t)
	f := newFake("create", Step{Key: "a", Label: "A", Status: StepPending})
	m.Register(f.kind())
	_, changes, unsubscribe := m.Subscribe()
	defer unsubscribe()

	if _, _, err := m.Start("create", "T", "/t", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	f.startedWith(t)
	expect(t, conn, changes, StateRunning, StepPending)
	f.step(t, Step{Key: "a", Label: "A", Status: StepRunning})
	expect(t, conn, changes, StateRunning, StepRunning)

	f.outcome <- Outcome{State: StateNeedsAnswer, Question: json.RawMessage(`{"key":"reuse_branch"}`)}
	final := expect(t, conn, changes, StateNeedsAnswer, StepPending)
	if string(final.Question) != `{"key":"reuse_branch"}` {
		t.Errorf("question %s", final.Question)
	}
	if final.FinishedAt != "" {
		t.Errorf("finished_at %q, want empty", final.FinishedAt)
	}
	m.Wait()
}

// park starts a job and parks it in needs_answer, returning its id.
func park(t *testing.T, m *Manager, f *fake, target string, request string) string {
	t.Helper()
	job, _, err := m.Start(f.name, "T", target, json.RawMessage(request))
	if err != nil {
		t.Fatal(err)
	}
	f.startedWith(t)
	f.outcome <- Outcome{State: StateNeedsAnswer, Question: json.RawMessage(`{"key":"q"}`)}
	m.Wait()
	return job.ID
}

func TestAnswerReplaysWithNewRequest(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	f := newFake("create", plan2()...)
	f.answer = func(request, question json.RawMessage, yes bool) (json.RawMessage, bool, error) {
		if !yes {
			t.Error("answer called with no")
		}
		return json.RawMessage(`{"x":2}`), false, nil
	}
	m.Register(f.kind())
	id := park(t, m, f, "/t", `{"x":1}`)

	job, err := m.Answer(id, true)
	if err != nil {
		t.Fatal(err)
	}
	if job.ID != id {
		t.Fatalf("id %q, want %q", job.ID, id)
	}
	if job.State != StateRunning {
		t.Fatalf("state %q", job.State)
	}
	if got := statuses(job); !reflect.DeepEqual(got, []StepStatus{StepPending, StepPending}) {
		t.Fatalf("steps %v, want reset to the plan", got)
	}
	if job.Question != nil {
		t.Errorf("question %s, want cleared", job.Question)
	}
	if got := string(f.startedWith(t)); got != `{"x":2}` {
		t.Fatalf("run got request %s, want the answered one", got)
	}
	f.outcome <- Outcome{State: StateSucceeded}
	m.Wait()
}

func TestAnswerEndDismisses(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	f := newFake("create", plan2()...)
	f.answer = func(request, question json.RawMessage, yes bool) (json.RawMessage, bool, error) {
		return nil, true, nil
	}
	m.Register(f.kind())
	id := park(t, m, f, "/t", `{"x":1}`)

	_, changes, unsubscribe := m.Subscribe()
	defer unsubscribe()
	if _, err := m.Answer(id, false); err != nil {
		t.Fatal(err)
	}
	ev := nextJob(t, changes)
	if ev.ID != id || !ev.Dismissed {
		t.Fatalf("event %+v, want a dismissal of %s", ev, id)
	}
	visible, err := m.Visible()
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != 0 {
		t.Fatalf("visible %+v, want empty", visible)
	}
	if got := f.calls.Load(); got != 1 {
		t.Fatalf("run called %d times, want 1", got)
	}
	m.Wait()
}

func TestAnswerOnlyWhenParked(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	f := newFake("create", plan2()...)
	f.answer = func(request, question json.RawMessage, yes bool) (json.RawMessage, bool, error) {
		return request, false, nil
	}
	m.Register(f.kind())

	job, _, err := m.Start("create", "T", "/t", json.RawMessage(`{"x":1}`))
	if err != nil {
		t.Fatal(err)
	}
	f.startedWith(t)
	if _, err := m.Answer(job.ID, true); !errors.Is(err, ErrWrongState) {
		t.Fatalf("answer on a running job: %v, want ErrWrongState", err)
	}

	f.outcome <- Outcome{State: StateNeedsAnswer, Question: json.RawMessage(`{"key":"q"}`)}
	m.Wait()
	if _, err := m.Answer(job.ID, true); err != nil {
		t.Fatal(err)
	}
	f.startedWith(t)
	if _, err := m.Answer(job.ID, true); !errors.Is(err, ErrWrongState) {
		t.Fatalf("second answer: %v, want ErrWrongState", err)
	}
	f.outcome <- Outcome{State: StateSucceeded}
	m.Wait()
	if got := f.calls.Load(); got != 2 {
		t.Fatalf("run called %d times, want 2", got)
	}
}

func TestRetryReplaysStoredRequest(t *testing.T) {
	t.Parallel()
	m, conn := newManager(t)
	f := newFake("create", plan2()...)
	m.Register(f.kind())

	job, _, err := m.Start("create", "T", "/t", json.RawMessage(`{"x":1}`))
	if err != nil {
		t.Fatal(err)
	}
	f.startedWith(t)
	f.outcome <- Outcome{State: StateFailed, Error: "nope"}
	m.Wait()
	if got := mustLoad(t, conn, job.ID); got.State != StateFailed || got.Error != "nope" {
		t.Fatalf("job %+v", got)
	}

	again, err := m.Retry(job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if again.State != StateRunning || again.Error != "" {
		t.Fatalf("retried job %+v", again)
	}
	if got := string(f.startedWith(t)); got != `{"x":1}` {
		t.Fatalf("run got request %s, want the stored one", got)
	}
	f.outcome <- Outcome{State: StateSucceeded}
	m.Wait()

	if _, err := m.Retry(job.ID); !errors.Is(err, ErrWrongState) {
		t.Fatalf("retry on a succeeded job: %v, want ErrWrongState", err)
	}
}

func TestDismissOnlyFinished(t *testing.T) {
	t.Parallel()
	m, conn := newManager(t)
	f := newFake("create", plan2()...)
	f.answer = func(request, question json.RawMessage, yes bool) (json.RawMessage, bool, error) {
		return request, false, nil
	}
	m.Register(f.kind())

	job, _, err := m.Start("create", "T", "/t", json.RawMessage(`{"x":1}`))
	if err != nil {
		t.Fatal(err)
	}
	f.startedWith(t)
	if err := m.Dismiss(job.ID); !errors.Is(err, ErrWrongState) {
		t.Fatalf("dismiss while running: %v, want ErrWrongState", err)
	}

	f.outcome <- Outcome{State: StateNeedsAnswer, Question: json.RawMessage(`{"key":"q"}`)}
	m.Wait()
	if err := m.Dismiss(job.ID); !errors.Is(err, ErrWrongState) {
		t.Fatalf("dismiss while needs_answer: %v, want ErrWrongState", err)
	}

	if _, err := m.Answer(job.ID, true); err != nil {
		t.Fatal(err)
	}
	f.startedWith(t)
	f.outcome <- Outcome{State: StateFailed, Error: "nope"}
	m.Wait()
	if err := m.Dismiss(job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := load(conn, job.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("load after dismiss: %v, want ErrNotFound", err)
	}
}

func TestCleanSuccessExpires(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	m.SuccessTTL = 20 * time.Millisecond
	f := newFake("create", plan2()...)
	m.Register(f.kind())

	_, changes, unsubscribe := m.Subscribe()
	defer unsubscribe()
	job, _, err := m.Start("create", "T", "/t", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	f.startedWith(t)
	f.outcome <- Outcome{State: StateSucceeded}
	m.Wait()

	nextJob(t, changes) // start
	nextJob(t, changes) // succeeded
	ev := nextJob(t, changes)
	if ev.ID != job.ID || !ev.Dismissed {
		t.Fatalf("event %+v, want a dismissal of %s", ev, job.ID)
	}
	visible, err := m.Visible()
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != 0 {
		t.Fatalf("visible %+v, want empty", visible)
	}
}

func TestSuccessWithFailedStepIsSticky(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	m.SuccessTTL = 20 * time.Millisecond
	f := newFake("create", plan2()...)
	m.Register(f.kind())

	if _, _, err := m.Start("create", "T", "/t", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	f.startedWith(t)
	f.step(t, Step{Key: "b", Label: "B", Status: StepFailed, Detail: "boom"})
	f.outcome <- Outcome{State: StateSucceeded}
	m.Wait()

	time.Sleep(100 * time.Millisecond)
	visible, err := m.Visible()
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != 1 || visible[0].State != StateSucceeded {
		t.Fatalf("visible %+v, want the sticky success", visible)
	}
}

func TestStartAttachesToUnfinishedJob(t *testing.T) {
	t.Parallel()
	m, conn := newManager(t)
	f := newFake("create", plan2()...)
	m.Register(f.kind())

	job, _, err := m.Start("create", "T", "/t", json.RawMessage(`{"x":1}`))
	if err != nil {
		t.Fatal(err)
	}
	f.startedWith(t)

	same, attached, err := m.Start("create", "T", "/t", json.RawMessage(`{"x":9}`))
	if err != nil {
		t.Fatal(err)
	}
	if !attached || same.ID != job.ID {
		t.Fatalf("second start: job %+v attached %v, want %s attached", same, attached, job.ID)
	}
	if got := f.calls.Load(); got != 1 {
		t.Fatalf("run called %d times, want 1", got)
	}
	f.outcome <- Outcome{State: StateSucceeded}
	m.Wait()

	// A job parked by an earlier server: a different manager, same DB.
	m2 := New(conn, os.Getpid())
	m2.Register(f.kind())
	parked := Job{
		ID: "deadbeefdeadbeef", Kind: "create", Title: "T", Target: "/other",
		State: StateNeedsAnswer, Steps: []Step{}, Request: json.RawMessage(`{"x":3}`),
		Question: json.RawMessage(`{"key":"q"}`), PID: os.Getpid(),
		CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z",
	}
	if err := save(conn, parked); err != nil {
		t.Fatal(err)
	}
	got, attached, err := m2.Start("create", "T", "/other", json.RawMessage(`{"x":4}`))
	if err != nil {
		t.Fatal(err)
	}
	if !attached || got.ID != parked.ID {
		t.Fatalf("start on a parked target: job %+v attached %v", got, attached)
	}
	m2.Wait()
}

func TestStartUnknownKind(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	if _, _, err := m.Start("nope", "T", "/t", json.RawMessage(`{}`)); !errors.Is(err, ErrUnknownKind) {
		t.Fatalf("got %v, want ErrUnknownKind", err)
	}
}

func TestRunPanicFailsJob(t *testing.T) {
	t.Parallel()
	m, conn := newManager(t)
	f := newFake("create", plan2()...)
	f.boom = true
	m.Register(f.kind())

	job, _, err := m.Start("create", "T", "/t", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	f.startedWith(t)
	m.Wait()

	got := mustLoad(t, conn, job.ID)
	if got.State != StateFailed {
		t.Fatalf("state %q, want failed", got.State)
	}
	if !strings.Contains(got.Error, "boom") {
		t.Fatalf("error %q, want it to mention boom", got.Error)
	}
	if running := m.Running(); len(running) != 0 {
		t.Fatalf("running %+v, want empty", running)
	}
}

func TestRecoverMarksRunningInterrupted(t *testing.T) {
	t.Parallel()
	m, conn := newManager(t)
	f := newFake("create", plan2()...)
	m.Register(f.kind())

	stale := Job{
		ID: "1111111111111111", Kind: "create", Title: "T", Target: "/t",
		State: StateRunning, Request: json.RawMessage(`{"x":1}`), PID: 1,
		CreatedAt: "2026-01-01T00:00:01Z", UpdatedAt: "2026-01-01T00:00:01Z",
		Steps: []Step{
			{Key: "a", Label: "A", Status: StepDone},
			{Key: "b", Label: "B", Status: StepRunning},
			{Key: "c", Label: "C", Status: StepPending},
		},
	}
	done := Job{
		ID: "2222222222222222", Kind: "create", Title: "T", Target: "/d",
		State: StateSucceeded, Request: json.RawMessage(`{}`), PID: 1,
		CreatedAt: "2026-01-01T00:00:02Z", UpdatedAt: "2026-01-01T00:00:02Z",
		FinishedAt: "2026-01-01T00:00:02Z",
		Steps:      []Step{{Key: "a", Label: "A", Status: StepDone}},
	}
	asking := Job{
		ID: "3333333333333333", Kind: "create", Title: "T", Target: "/q",
		State: StateNeedsAnswer, Request: json.RawMessage(`{}`), PID: 1,
		CreatedAt: "2026-01-01T00:00:03Z", UpdatedAt: "2026-01-01T00:00:03Z",
		Question: json.RawMessage(`{"key":"q"}`),
		Steps:    []Step{{Key: "a", Label: "A", Status: StepPending}},
	}
	for _, j := range []Job{stale, done, asking} {
		if err := save(conn, j); err != nil {
			t.Fatal(err)
		}
	}

	if err := m.Recover(); err != nil {
		t.Fatal(err)
	}

	got := mustLoad(t, conn, stale.ID)
	if got.State != StateInterrupted || got.FinishedAt == "" {
		t.Fatalf("stale job %+v, want interrupted and finished", got)
	}
	want := []Step{
		{Key: "a", Label: "A", Status: StepDone},
		{Key: "b", Label: "B", Status: StepFailed, Detail: "interrupted: the server stopped"},
		{Key: "c", Label: "C", Status: StepPending},
	}
	if !reflect.DeepEqual(got.Steps, want) {
		t.Fatalf("steps %+v, want %+v", got.Steps, want)
	}
	if _, err := load(conn, done.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("clean success after recover: %v, want ErrNotFound", err)
	}
	if got := mustLoad(t, conn, asking.ID); !reflect.DeepEqual(got, asking) {
		t.Fatalf("parked job %+v, want it untouched (%+v)", got, asking)
	}

	if _, err := m.Retry(stale.ID); err != nil {
		t.Fatal(err)
	}
	if got := string(f.startedWith(t)); got != `{"x":1}` {
		t.Fatalf("run got request %s", got)
	}
	f.outcome <- Outcome{State: StateSucceeded}
	m.Wait()
}

func TestSubscribeSnapshotIsAtomic(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	f := newFake("create", plan2()...)
	m.Register(f.kind())

	if _, _, err := m.Start("create", "T", "/t", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	f.startedWith(t)
	f.step(t, Step{Key: "a", Label: "A", Status: StepRunning})

	snapshot, changes, unsubscribe := m.Subscribe()
	defer unsubscribe()
	if len(snapshot) != 1 {
		t.Fatalf("snapshot %+v, want one job", snapshot)
	}
	if got := statuses(snapshot[0]); !reflect.DeepEqual(got, []StepStatus{StepRunning, StepPending}) {
		t.Fatalf("snapshot steps %v", got)
	}

	f.step(t, Step{Key: "a", Label: "A", Status: StepDone})
	ev := nextJob(t, changes)
	if got := statuses(ev); !reflect.DeepEqual(got, []StepStatus{StepDone, StepPending}) {
		t.Fatalf("first event steps %v, want exactly the next report", got)
	}
	f.outcome <- Outcome{State: StateSucceeded}
	m.Wait()
}

func TestSlowSubscriberIsDropped(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	f := newFake("create", plan2()...)
	m.Register(f.kind())

	_, changes, unsubscribe := m.Subscribe()
	defer unsubscribe()
	if _, _, err := m.Start("create", "T", "/t", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	f.startedWith(t)
	for i := 0; i < 65; i++ {
		f.step(t, Step{Key: fmt.Sprintf("s%d", i), Label: "S", Status: StepDone})
	}
	f.outcome <- Outcome{State: StateSucceeded}
	m.Wait()

	// Draining what was buffered must reach a closed channel.
	for i := 0; i < 128; i++ {
		select {
		case _, ok := <-changes:
			if !ok {
				return
			}
		case <-time.After(2 * time.Second):
			t.Fatal("timed out draining the dropped subscriber")
		}
	}
	t.Fatal("channel of a subscriber that never read was not closed")
}

func TestRunningListsOnlyExecuting(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	busy := newFake("create", plan2()...)
	idle := newFake("delete", plan2()...)
	m.Register(busy.kind())
	m.Register(idle.kind())

	_, changes, unsubscribe := m.Subscribe()
	defer unsubscribe()
	job, _, err := m.Start("create", "T", "/busy", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	busy.startedWith(t)
	parked, _, err := m.Start("delete", "T", "/idle", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	idle.startedWith(t)
	idle.outcome <- Outcome{State: StateNeedsAnswer, Question: json.RawMessage(`{"key":"q"}`)}
	waitFor(t, changes, parked.ID, StateNeedsAnswer)

	running := m.Running()
	if len(running) != 1 || running[0].ID != job.ID {
		t.Fatalf("running %+v, want only %s", running, job.ID)
	}
	busy.outcome <- Outcome{State: StateSucceeded}
	m.Wait()
}

// A run that cannot be saved must not be announced: nothing would ever clear
// the toast, because no goroutine and no row exist to produce a later event.
// Start, Answer and Retry all begin a run through the same code.
func TestBeginSaveFailurePublishesNothing(t *testing.T) {
	t.Parallel()
	_, read := readOnlyPair(t)
	m := New(read, os.Getpid())
	f := newFake("create", plan2()...)
	m.Register(f.kind())

	_, changes, unsubscribe := m.Subscribe()
	defer unsubscribe()
	if _, _, err := m.Start("create", "T", "/t", json.RawMessage(`{}`)); err == nil {
		t.Fatal("start on a read-only DB returned no error")
	}
	expectNoChange(t, changes)
	if running := m.Running(); len(running) != 0 {
		t.Fatalf("running %+v, want empty", running)
	}
	if got := f.calls.Load(); got != 0 {
		t.Fatalf("run called %d times, want 0", got)
	}
	m.Wait()
}

// A dismissal that cannot delete the row must not be announced either: the
// client would drop a job that is still in Visible.
func TestDismissRemoveFailurePublishesNothing(t *testing.T) {
	t.Parallel()
	write, read := readOnlyPair(t)
	job := Job{
		ID: "4444444444444444", Kind: "create", Title: "T", Target: "/t",
		State: StateFailed, Steps: []Step{}, Request: json.RawMessage(`{}`),
		Error: "nope", PID: os.Getpid(), CreatedAt: "2026-01-01T00:00:00Z",
		UpdatedAt: "2026-01-01T00:00:00Z", FinishedAt: "2026-01-01T00:00:00Z",
	}
	if err := save(write, job); err != nil {
		t.Fatal(err)
	}
	m := New(read, os.Getpid())

	_, changes, unsubscribe := m.Subscribe()
	defer unsubscribe()
	if err := m.Dismiss(job.ID); err == nil {
		t.Fatal("dismiss on a read-only DB returned no error")
	}
	expectNoChange(t, changes)
	if _, err := load(write, job.ID); err != nil {
		t.Fatalf("row after a failed dismiss: %v, want it still there", err)
	}
}

// Inside a run there is no caller to return a save failure to, so it has to
// reach Logf: otherwise the published state and the stored row part silently.
func TestSaveFailureDuringRunReachesLogf(t *testing.T) {
	t.Parallel()
	m, conn := newManager(t)
	var mu sync.Mutex
	var logs []string
	m.Logf = func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		logs = append(logs, fmt.Sprintf(format, args...))
	}
	f := newFake("create", plan2()...)
	m.Register(f.kind())

	job, _, err := m.Start("create", "T", "/t", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	f.startedWith(t)
	if _, err := conn.Exec(`DROP TABLE jobs`); err != nil {
		t.Fatal(err)
	}
	f.step(t, Step{Key: "a", Label: "A", Status: StepRunning})
	f.outcome <- Outcome{State: StateSucceeded}
	m.Wait()

	mu.Lock()
	defer mu.Unlock()
	if len(logs) != 2 {
		t.Fatalf("logged %v, want one line for the step and one for the outcome", logs)
	}
	for _, want := range []string{job.ID, "step a"} {
		if !strings.Contains(logs[0], want) {
			t.Errorf("step failure %q does not mention %q", logs[0], want)
		}
	}
	for _, want := range []string{job.ID, "succeeded"} {
		if !strings.Contains(logs[1], want) {
			t.Errorf("outcome failure %q does not mention %q", logs[1], want)
		}
	}
}
