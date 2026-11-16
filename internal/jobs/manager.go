package jobs

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

// ErrWrongState is returned when a job's state does not allow the operation.
var ErrWrongState = errors.New("job is not in a state that allows this")

// ErrUnknownKind is returned when no kind of the requested name is registered.
var ErrUnknownKind = errors.New("unknown job kind")

// interruptedDetail is the detail left on the step a dead server was running.
const interruptedDetail = "interrupted: the server stopped"

// changeBuffer is how many changes a subscriber may fall behind before its
// channel is closed and dropped.
const changeBuffer = 64

// defaultSuccessTTL is how long a clean success stays visible.
const defaultSuccessTTL = 10 * time.Second

// Outcome is how one run of a job ended.
type Outcome struct {
	State    State           // StateSucceeded, StateFailed or StateNeedsAnswer
	Question json.RawMessage // with StateNeedsAnswer
	Result   json.RawMessage // kept on the job when non-nil
	Error    string
}

// Kind is one sort of job the manager knows how to run.
type Kind struct {
	Name string
	// Plan is every step a run of request will show, all StepPending.
	Plan func(request json.RawMessage) []Step
	// Run executes request. report upserts one step by Key (appending a key
	// the plan lacks). It is called from the job's goroutine only.
	Run func(request json.RawMessage, report func(Step)) Outcome
	// Answer turns a yes/no to question into the request to replay.
	// end=true means the job simply ends: it is dismissed, nothing runs.
	Answer func(request, question json.RawMessage, yes bool) (next json.RawMessage, end bool, err error)
}

// Manager runs jobs in this process, persists every change, and fans each
// change out to its subscribers.
type Manager struct {
	SuccessTTL time.Duration // default 10s; a clean success is dismissed after it

	// Logf, when set, is told about the failures no caller can be: a job's
	// own goroutine has nobody to return an error to, so a save that fails
	// there would otherwise part the published state from the stored row in
	// silence. A field, not a global: the package keeps no mutable state.
	Logf func(format string, args ...any)

	conn *sql.DB
	pid  int

	// mu guards everything below, and every save, publish and snapshot, so a
	// subscriber never sees a gap between its snapshot and its changes.
	mu      sync.Mutex
	kinds   map[string]Kind
	exec    map[string]Job         // executing in this process right now
	subs    map[int]chan Job       // subscriber id -> changes
	timers  map[string]*time.Timer // pending success expiries
	nextSub int

	wg sync.WaitGroup // one entry per executing job
}

// New returns a manager storing jobs in conn and stamping them with pid.
func New(conn *sql.DB, pid int) *Manager {
	return &Manager{
		SuccessTTL: defaultSuccessTTL,
		conn:       conn,
		pid:        pid,
		kinds:      map[string]Kind{},
		exec:       map[string]Job{},
		subs:       map[int]chan Job{},
		timers:     map[string]*time.Timer{},
	}
}

// Register adds a kind; a kind of the same name is replaced.
func (m *Manager) Register(k Kind) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.kinds[k.Name] = k
}

func newID() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// upsertStep returns steps with s in place of the step of the same key, or
// appended. The result is always a new slice: published jobs share theirs.
func upsertStep(steps []Step, s Step) []Step {
	out := make([]Step, len(steps), len(steps)+1)
	copy(out, steps)
	for i := range out {
		if out[i].Key == s.Key {
			out[i] = s
			return out
		}
	}
	return append(out, s)
}

// Recover turns the rows a dead server left behind into states the user can
// act on. It is called once at server start, before any Start.
func (m *Manager) Recover() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	list, err := all(m.conn)
	if err != nil {
		return err
	}
	stamp := now()
	for _, j := range list {
		switch {
		case j.State == StateRunning:
			steps := make([]Step, len(j.Steps))
			copy(steps, j.Steps)
			for i := range steps {
				if steps[i].Status == StepRunning {
					steps[i].Status = StepFailed
					steps[i].Detail = interruptedDetail
				}
			}
			j.Steps = steps
			j.State = StateInterrupted
			j.UpdatedAt = stamp
			j.FinishedAt = stamp
			if err := save(m.conn, j); err != nil {
				return err
			}
		case j.State == StateSucceeded && !j.HasFailedStep():
			// Its expiry timer died with the old server.
			if err := remove(m.conn, j.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

// Start runs a new job, or returns the unfinished job already on
// (kind, target) with attached=true.
func (m *Manager) Start(kind, title, target string, request json.RawMessage) (Job, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k, ok := m.kinds[kind]
	if !ok {
		return Job{}, false, ErrUnknownKind
	}
	open, err := Unfinished(m.conn)
	if err != nil {
		return Job{}, false, err
	}
	for _, j := range open {
		if j.Kind == kind && j.Target == target {
			return j, true, nil
		}
	}
	id, err := newID()
	if err != nil {
		return Job{}, false, err
	}
	stamp := now()
	job := Job{
		ID: id, Kind: kind, Title: title, Target: target,
		Steps: []Step{}, CreatedAt: stamp, UpdatedAt: stamp,
		Request: request, PID: m.pid,
	}
	job, err = m.beginLocked(k, job)
	return job, false, err
}

// beginLocked puts job into a fresh run and launches its goroutine.
func (m *Manager) beginLocked(k Kind, job Job) (Job, error) {
	m.stopTimerLocked(job.ID)
	steps := k.Plan(job.Request)
	if steps == nil {
		steps = []Step{}
	}
	job.State = StateRunning
	job.Steps = steps
	job.Question = nil
	job.Error = ""
	job.FinishedAt = ""
	job.PID = m.pid
	job.UpdatedAt = now()
	// Save before publishing: a job the subscribers are told is running, but
	// whose goroutine never starts, is a toast nothing can ever clear.
	if err := save(m.conn, job); err != nil {
		return Job{}, err
	}
	m.exec[job.ID] = job
	m.wg.Add(1)
	go m.execute(k, job.ID, job.Request)
	m.publishLocked(job)
	return job, nil
}

// execute runs the kind and applies its outcome. It never returns an error:
// nothing is waiting for one, and a panic in the kind must not take the
// server down.
func (m *Manager) execute(k Kind, id string, request json.RawMessage) {
	defer m.wg.Done()
	report := func(s Step) {
		m.mu.Lock()
		defer m.mu.Unlock()
		job, ok := m.exec[id]
		if !ok {
			return
		}
		job.Steps = upsertStep(job.Steps, s)
		job.UpdatedAt = now()
		m.exec[id] = job
		if err := m.saveAndPublishLocked(job); err != nil {
			m.logfLocked("job %s: saving step %s: %v", id, s.Key, err)
		}
	}
	m.finish(id, runKind(k, request, report))
}

// runKind calls the kind's Run, turning a panic into a failed outcome.
func runKind(k Kind, request json.RawMessage, report func(Step)) (out Outcome) {
	defer func() {
		if r := recover(); r != nil {
			out = Outcome{State: StateFailed, Error: fmt.Sprintf("job panicked: %v", r)}
		}
	}()
	return k.Run(request, report)
}

// finish applies a run's outcome to the job and stops executing it.
func (m *Manager) finish(id string, out Outcome) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, ok := m.exec[id]
	if !ok {
		return
	}
	delete(m.exec, id)
	steps := make([]Step, len(job.Steps))
	copy(steps, job.Steps)
	for i := range steps {
		if steps[i].Status == StepRunning {
			steps[i].Status = StepPending
		}
	}
	job.Steps = steps
	job.State = out.State
	job.Question = out.Question
	job.Error = out.Error
	if out.Result != nil {
		job.Result = out.Result
	}
	job.UpdatedAt = now()
	if job.Finished() {
		job.FinishedAt = job.UpdatedAt
	} else {
		job.FinishedAt = ""
	}
	if err := m.saveAndPublishLocked(job); err != nil {
		m.logfLocked("job %s: saving the %s outcome: %v", id, job.State, err)
	}
	if job.State == StateSucceeded && !job.HasFailedStep() {
		m.expireLaterLocked(job.ID)
	}
}

// expireLaterLocked dismisses a clean success once SuccessTTL has passed.
func (m *Manager) expireLaterLocked(id string) {
	m.timers[id] = time.AfterFunc(m.SuccessTTL, func() { m.expire(id) })
}

func (m *Manager) expire(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.timers, id)
	job, err := load(m.conn, id)
	if err != nil {
		return // already gone, or the DB is closed
	}
	if job.State != StateSucceeded || job.HasFailedStep() {
		return
	}
	if err := m.dismissLocked(job); err != nil {
		m.logfLocked("job %s: dismissing an expired success: %v", id, err)
	}
}

// logfLocked reports a failure nothing is waiting for. The lock is held, so
// Logf must not call back into the manager.
func (m *Manager) logfLocked(format string, args ...any) {
	if m.Logf != nil {
		m.Logf(format, args...)
	}
}

func (m *Manager) stopTimerLocked(id string) {
	if t, ok := m.timers[id]; ok {
		t.Stop()
		delete(m.timers, id)
	}
}

// dismissLocked deletes the job, then publishes it once more as dismissed.
// The delete comes first: telling a client the job is gone while its row
// survives would leave it in Visible, back on the next reload.
func (m *Manager) dismissLocked(job Job) error {
	m.stopTimerLocked(job.ID)
	if err := remove(m.conn, job.ID); err != nil {
		return err
	}
	job.Dismissed = true
	job.UpdatedAt = now()
	m.publishLocked(job)
	return nil
}

// Answer applies a yes or no to the question a parked job is asking.
func (m *Manager) Answer(id string, yes bool) (Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, err := load(m.conn, id)
	if err != nil {
		return Job{}, err
	}
	if job.State != StateNeedsAnswer {
		return Job{}, ErrWrongState
	}
	k, ok := m.kinds[job.Kind]
	if !ok {
		return Job{}, ErrUnknownKind
	}
	next, end, err := k.Answer(job.Request, job.Question, yes)
	if err != nil {
		return Job{}, err
	}
	if end {
		if err := m.dismissLocked(job); err != nil {
			return Job{}, err
		}
		job.Dismissed = true
		return job, nil
	}
	job.Request = next
	return m.beginLocked(k, job)
}

// Retry runs a failed or interrupted job's stored request again.
func (m *Manager) Retry(id string) (Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, err := load(m.conn, id)
	if err != nil {
		return Job{}, err
	}
	if job.State != StateFailed && job.State != StateInterrupted {
		return Job{}, ErrWrongState
	}
	k, ok := m.kinds[job.Kind]
	if !ok {
		return Job{}, ErrUnknownKind
	}
	return m.beginLocked(k, job)
}

// Dismiss removes a finished job.
func (m *Manager) Dismiss(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, err := load(m.conn, id)
	if err != nil {
		return err
	}
	if !job.Finished() {
		return ErrWrongState
	}
	return m.dismissLocked(job)
}

// Visible lists every job a client should see, oldest first.
func (m *Manager) Visible() ([]Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return all(m.conn)
}

// Running is the jobs executing in this process right now.
func (m *Manager) Running() []Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Job, 0, len(m.exec))
	for _, j := range m.exec {
		out = append(out, j)
	}
	return out
}

// Subscribe returns the visible jobs and a channel of every later change,
// taken under one lock so nothing falls between them. The channel is closed
// if the subscriber falls changeBuffer changes behind. A snapshot that cannot
// be read is empty: the subscriber still gets every later change.
func (m *Manager) Subscribe() ([]Job, <-chan Job, func()) {
	m.mu.Lock()
	defer m.mu.Unlock()
	snapshot, err := all(m.conn)
	if err != nil {
		snapshot = nil
	}
	ch := make(chan Job, changeBuffer)
	id := m.nextSub
	m.nextSub++
	m.subs[id] = ch
	return snapshot, ch, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.dropLocked(id)
	}
}

func (m *Manager) dropLocked(id int) {
	ch, ok := m.subs[id]
	if !ok {
		return
	}
	delete(m.subs, id)
	close(ch)
}

// saveAndPublishLocked persists the job and hands it to the subscribers. It
// publishes even if the save failed: the change really happened, and a client
// is better off seeing it than waiting for one that never comes.
func (m *Manager) saveAndPublishLocked(job Job) error {
	err := save(m.conn, job)
	m.publishLocked(job)
	return err
}

// publishLocked hands the job to every subscriber. It never blocks: a
// subscriber that is too far behind is dropped.
func (m *Manager) publishLocked(job Job) {
	for id, ch := range m.subs {
		select {
		case ch <- job:
		default:
			m.dropLocked(id)
		}
	}
}

// Wait blocks until no job is executing. For tests and shutdown.
func (m *Manager) Wait() { m.wg.Wait() }
