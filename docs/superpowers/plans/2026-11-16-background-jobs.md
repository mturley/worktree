# Background Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Worktree create and delete become server-side jobs whose steps stream live to the starting modal and to a toast stack in every tab, surviving reloads and server restarts.

**Architecture:** A new pure package `internal/jobs` owns a job manager: it runs each job in a goroutine, persists the job row on every change, and fans changes out to subscribers. `internal/webui` registers two job kinds (adapters over the existing `worktreenew` / `worktreedel` runners), exposes job routes, and forwards changes over `/api/stream`. The frontend keeps one external store of jobs fed only by the stream; the modals and a root-mounted toast stack render from it.

**Tech Stack:** Go (net/http, SQLite via `internal/db`), React + Mantine + TanStack Query, vitest, POSIX sh for the install script.

**Spec:** `docs/superpowers/specs/2026-11-16-background-jobs-design.md` — read it first; this plan does not repeat its reasoning.

## Global Constraints

- These are **jobs**, never "tasks", in every identifier, route, event and string (`internal/tasks` is to-dos).
- The job manager is a field on `webui.Server`, reached through a lazy accessor `s.jobs()`; no package-level state in `internal/jobs` or `internal/webui`.
- `internal/worktreenew` and `internal/worktreedel` behaviour is unchanged for the CLI. Only additive exports (Task 3).
- New top-level tests in `internal/webui` call `t.Parallel()` first unless they use `t.Setenv`, assign a package var, or stub `cmux` (then serial). Git fixtures come from `testgit`, never built per test.
- Tests never send real signals and never reach cmux, GitHub, or the user's config.
- JSON from the CLI goes through `printJSON` (`schema_version: 1`, snake_case, an object).
- Commits: `git commit --signoff`, add files by name (never `git add -A` / `.`), message ends with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Frontend: run `npm test` and `npm run build` from `ui/`. Go: `go test ./...`; after touching `internal/webui`, also `go test -race ./internal/webui/ ./internal/jobs/`.
- Between Task 4 and Task 10 the web UI's create/delete modals are broken at runtime (the server answers with jobs before the modals understand them). This is expected on the feature branch; do not paper over it.

## Review Focus

1. **The server is killed mid-job.** On next start the job is `interrupted`, its in-flight step no longer spins, the toast can be closed, and "Run again" works. → Task 2 `TestRecoverMarksRunningInterrupted`.
2. **The runner panics inside the job goroutine.** Before this change `net/http` recovered a handler panic; a goroutine panic would now kill the server. The job must end `failed` with the panic text and the server stay up. → Task 2 `TestRunPanicFailsJob`.
3. **A tab reconnects after sleep, and a job it shows was dismissed meanwhile.** The toast must go, not stay forever. → Task 2 `TestSubscribeSnapshotIsAtomic`, Task 4 `TestStreamSendsJobsSnapshotFirst`, Task 8 `setJobs replaces the store`.
4. **A second delete is started on a worktree whose job is running or parked — including a parked job loaded from the DB after a restart.** It attaches; no second run. → Task 2 `TestStartAttachesToUnfinishedJob`.
5. **Two tabs answer the same question (or one double-clicks).** The second gets 409 and nothing runs twice. → Task 2 `TestAnswerOnlyWhenParked`, Task 4 `TestJobAnswerConflict`.

---

## File Structure

| File | Responsibility |
|---|---|
| `internal/db/migrate.go` | `jobs` table; `schemaVersion` 5 |
| `internal/jobs/job.go` | `Job`, `Step`, states, `Kind`, `Outcome` |
| `internal/jobs/store.go` | row read/write, `Unfinished` |
| `internal/jobs/manager.go` | run, answer, retry, dismiss, expiry, recover, subscribe |
| `internal/worktreenew/worktreenew.go`, `internal/worktreedel/worktreedel.go` | `Planned` step lists |
| `internal/webui/jobs_kinds.go` | create/delete adapters, request types |
| `internal/webui/jobs_api.go` | `s.jobs()`, job routes |
| `internal/webui/worktree_create_api.go`, `worktree_delete_api.go` | start handlers return a job |
| `internal/webui/stream.go` | `jobs` / `job` events |
| `internal/webui/cmux_api.go` | `createCmuxWorkspace` extracted for the job step |
| `internal/webui/stop.go` | stop-signal guard |
| `cmd/ui.go`, `cmd/jobs.go` | signal wiring; `worktree jobs` |
| `scripts/stop-running.sh`, `Makefile`, `.air.toml` | install prompt; dev restart |
| `ui/src/api/types.ts`, `ui/src/api/client.ts` | job types and calls |
| `ui/src/lib/jobsStore.ts` | the one client store |
| `ui/src/hooks/useSSE.ts` | feeds the store |
| `ui/src/components/jobs/JobStepper.tsx` | shared step list |
| `ui/src/components/jobs/JobToasts.tsx` | toast stack |
| `ui/src/components/jobs/JobModalHost.tsx` | opens a modal on an existing job |
| `ui/src/components/NewWorktreeModal.tsx`, `DeleteWorktreeModal.tsx` | render from a job |

---

### Task 1: Job model, table and store

**Files:**
- Modify: `internal/db/migrate.go` (append table; `schemaVersion = 5`)
- Create: `internal/jobs/job.go`, `internal/jobs/store.go`
- Test: `internal/jobs/store_test.go`

**Interfaces:**
- Produces:

```go
package jobs

type State string
const (
	StateRunning     State = "running"
	StateNeedsAnswer State = "needs_answer"
	StateSucceeded   State = "succeeded"
	StateFailed      State = "failed"
	StateInterrupted State = "interrupted"
)

type StepStatus string
const (
	StepPending    StepStatus = "pending"   // not reached
	StepRunning    StepStatus = "running"   // in flight
	StepDone       StepStatus = "done"
	StepSkipped    StepStatus = "skipped"
	StepFailed     StepStatus = "failed"
	StepNeedsForce StepStatus = "needs_force"
)

type Step struct {
	Key    string     `json:"key"`
	Label  string     `json:"label"`
	Status StepStatus `json:"status"`
	Detail string     `json:"detail,omitempty"`
}

type Job struct {
	ID         string          `json:"id"`
	Kind       string          `json:"kind"`
	Title      string          `json:"title"`
	Target     string          `json:"target"`
	State      State           `json:"state"`
	Steps      []Step          `json:"steps"`              // never null
	Question   json.RawMessage `json:"question"`           // null unless needs_answer
	Result     json.RawMessage `json:"result"`             // null until a kind sets it
	Error      string          `json:"error,omitempty"`
	CreatedAt  string          `json:"created_at"`         // RFC3339Nano UTC
	UpdatedAt  string          `json:"updated_at"`
	FinishedAt string          `json:"finished_at,omitempty"`
	Dismissed  bool            `json:"dismissed,omitempty"` // only on the final event for a job
	Request    json.RawMessage `json:"-"`
	PID        int             `json:"-"`
}

func (j Job) Finished() bool   // succeeded, failed or interrupted
func (j Job) HasFailedStep() bool

// store.go
func save(conn *sql.DB, j Job) error                    // upsert by id
func load(conn *sql.DB, id string) (Job, error)         // ErrNotFound
func remove(conn *sql.DB, id string) error
func all(conn *sql.DB) ([]Job, error)                   // oldest first
// Unfinished lists running and needs_answer jobs, oldest first. A DB with no
// jobs table (older schema) is an empty list, not an error.
func Unfinished(conn *sql.DB) ([]Job, error)
var ErrNotFound = errors.New("job not found")
```

- Table (in `migrate`):

```sql
CREATE TABLE IF NOT EXISTS jobs (
	id          TEXT PRIMARY KEY,
	kind        TEXT NOT NULL,
	title       TEXT NOT NULL,
	target      TEXT NOT NULL,
	request     TEXT NOT NULL,
	state       TEXT NOT NULL,
	steps       TEXT NOT NULL,
	question    TEXT,
	result      TEXT,
	error       TEXT NOT NULL DEFAULT '',
	pid         INTEGER NOT NULL,
	created_at  TEXT NOT NULL,
	updated_at  TEXT NOT NULL,
	finished_at TEXT
)
```

- [ ] **Step 1: Write failing tests** in `internal/jobs/store_test.go` (DB via `wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))`, all `t.Parallel()`):
  - `TestSaveLoadRoundTrip`: save a job with two steps, a question `{"key":"reuse_branch"}`, request `{"path":"/x"}`, pid 42; `load` returns an equal job (including `Request` and `PID`).
  - `TestSaveUpserts`: save twice with a changed state; `all` has one row with the second state.
  - `TestLoadMissing`: `load(conn, "nope")` is `ErrNotFound`.
  - `TestUnfinishedFilters`: five jobs, one per state; `Unfinished` returns exactly the `running` and `needs_answer` ones, oldest first.
  - `TestUnfinishedWithoutTable`: on a bare SQLite file with no tables, `Unfinished` returns `nil, nil`.
  - `TestJobJSONShape`: marshalling a zero-step job gives `"steps":[]`, `"question":null`, and no `request` or `pid` key.
- [ ] **Step 2: Run** `go test ./internal/jobs/` — FAIL (package does not compile).
- [ ] **Step 3: Implement** the table, bump `schemaVersion` to 5, and write `job.go` / `store.go`. `steps`, `question`, `result`, `request` are stored as JSON text; a nil `Steps` is saved and loaded as an empty slice.
- [ ] **Step 4: Run** `go test ./internal/jobs/ ./internal/db/` — PASS (`TestSchemaVersionCoversSchema` included).
- [ ] **Step 5: Commit** `feat(jobs): job model, table and store`.

---

### Task 2: Job manager

**Files:**
- Create: `internal/jobs/manager.go`
- Test: `internal/jobs/manager_test.go`

**Interfaces:**
- Consumes: Task 1.
- Produces:

```go
// Outcome is how one run of a job ended.
type Outcome struct {
	State    State           // StateSucceeded, StateFailed or StateNeedsAnswer
	Question json.RawMessage // with StateNeedsAnswer
	Result   json.RawMessage // kept on the job when non-nil
	Error    string
}

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

type Manager struct {
	SuccessTTL time.Duration // default 10s; a clean success is dismissed after it
}

func New(conn *sql.DB, pid int) *Manager
func (m *Manager) Register(k Kind) // a kind of the same name is replaced
// Recover is called once at server start, before any Start.
func (m *Manager) Recover() error
// Start runs a new job, or returns the unfinished job already on
// (kind, target) with attached=true.
func (m *Manager) Start(kind, title, target string, request json.RawMessage) (job Job, attached bool, err error)
func (m *Manager) Answer(id string, yes bool) (Job, error)
func (m *Manager) Retry(id string) (Job, error)
func (m *Manager) Dismiss(id string) error
func (m *Manager) Visible() ([]Job, error)
// Running is the jobs executing in this process right now.
func (m *Manager) Running() []Job
// Subscribe returns the visible jobs and a channel of every later change,
// taken under one lock so nothing falls between them. The channel is closed
// if the subscriber falls 64 changes behind.
func (m *Manager) Subscribe() (snapshot []Job, changes <-chan Job, unsubscribe func())
// Wait blocks until no job is executing. For tests and shutdown.
func (m *Manager) Wait()

var ErrWrongState = errors.New("job is not in a state that allows this")
var ErrUnknownKind = errors.New("unknown job kind")
```

**Behaviour the tests pin** (all from the spec's "Job model"):

- Ids are 16 random hex characters (`crypto/rand`).
- A run: state `running`, steps = `Plan(request)`, `Question` cleared, `Error` cleared, `FinishedAt` cleared, saved and published; then `Run` in a goroutine; each `report` saves and publishes. When `Run` returns, every step still `running` becomes `pending`, the outcome is applied, saved, published.
- Every publish and every snapshot happens under the manager's one mutex. Publishing never blocks: a full subscriber channel is closed and dropped.
- A clean `succeeded` (no failed step) is dismissed after `SuccessTTL`. A `succeeded` job with a failed step is not.
- Dismissing publishes the job once more with `Dismissed: true`, then deletes its row. `Visible` is simply every row.
- `Answer`: only in `needs_answer`, else `ErrWrongState`. `end` → dismiss. Otherwise store `next` as the request and run again under the same id.
- `Retry`: only `failed` / `interrupted`, else `ErrWrongState`; runs the stored request under the same id.
- `Dismiss`: only finished states, else `ErrWrongState`.
- `Recover`: every `running` row becomes `interrupted`, `FinishedAt` set, its `running` step set to `failed` with detail `interrupted: the server stopped`. Every clean `succeeded` row is deleted (its expiry timer died with the old server).

- [ ] **Step 1: Write failing tests** in `manager_test.go`. Use a fake kind whose `Run` is driven by channels so the test controls when each step reports and when the run returns. All `t.Parallel()`.
  - `TestStartRunsAndStreamsSteps`: subscribe; start a job with plan `[a, b]`; let the kind report `a` running, `a` done, `b` running, `b` done, return succeeded. The channel yields, in order, states/steps: running with `[pending,pending]`; `[running,pending]`; `[done,pending]`; `[done,running]`; `[done,done]`; then `succeeded`. `load` from the DB after each matches.
  - `TestRunResetsRunningStepsAtEnd`: kind reports `a` running then returns `needs_answer` with a question → final job has `a` `pending`, state `needs_answer`, question set.
  - `TestAnswerReplaysWithNewRequest`: parked job; `Answer(id, true)` where the kind's `Answer` returns `{"x":2}` → kind's `Run` is called again with `{"x":2}`; same id; steps reset to the plan.
  - `TestAnswerEndDismisses`: kind's `Answer` returns `end=true` → a `Dismissed: true` event; `Visible` is empty; `Run` not called again.
  - `TestAnswerOnlyWhenParked`: `Answer` on a running job, and a second `Answer` after the first already restarted it, both return `ErrWrongState`; `Run` was called exactly twice in total (start + one answer).
  - `TestRetryReplaysStoredRequest`: failed job → `Retry` runs with the same request; `Retry` on a succeeded job is `ErrWrongState`.
  - `TestDismissOnlyFinished`: `Dismiss` on running and on needs_answer is `ErrWrongState`; on failed it removes the row.
  - `TestCleanSuccessExpires`: `SuccessTTL = 20ms`; a clean success produces a `Dismissed` event and an empty `Visible`.
  - `TestSuccessWithFailedStepIsSticky`: `SuccessTTL = 20ms`; success with one `failed` step is still in `Visible` after 100ms.
  - `TestStartAttachesToUnfinishedJob`: start on `(kind, "/t")` and leave it running → second `Start` on the same pair returns the same id, `attached=true`, and `Run` was called once. Then: build a second `Manager` on the same DB holding a `needs_answer` row (saved directly), and `Start` on its target attaches too.
  - `TestStartUnknownKind`: `ErrUnknownKind`.
  - `TestRunPanicFailsJob`: kind's `Run` panics with `"boom"` → job ends `failed`, `Error` contains `boom`; the test process survives; `Running()` is empty.
  - `TestRecoverMarksRunningInterrupted`: save a `running` job with steps `[done, running, pending]`, a clean `succeeded` job, and a `needs_answer` job; `Recover` → the first is `interrupted` with steps `[done, failed("interrupted: the server stopped"), pending]`; the second is gone; the third is untouched. Then `Retry` on the first runs it.
  - `TestSubscribeSnapshotIsAtomic`: with one job mid-run, `Subscribe` returns it in the snapshot and its next step on the channel, with no duplicate and no gap (the first channel event's step list differs from the snapshot's by exactly the next report).
  - `TestSlowSubscriberIsDropped`: a subscriber that never reads; push 65 reports; the job still finishes (`Wait` returns) and the subscriber's channel is closed.
  - `TestRunningListsOnlyExecuting`: one running, one parked → `Running()` has the first only.
- [ ] **Step 2: Run** `go test ./internal/jobs/` — FAIL.
- [ ] **Step 3: Implement** `manager.go`. Wrap the kind's `Run` call in a `recover` that turns a panic into `Outcome{State: StateFailed, Error: fmt.Sprintf("job panicked: %v", r)}`. Expiry uses `time.AfterFunc`.
- [ ] **Step 4: Run** `go test -race ./internal/jobs/` — PASS.
- [ ] **Step 5: Commit** `feat(jobs): job manager`.

---

### Task 3: Runners expose their planned steps

**Files:**
- Modify: `internal/worktreenew/worktreenew.go`, `internal/worktreedel/worktreedel.go`
- Test: `internal/worktreenew/worktreenew_test.go`, `internal/worktreedel/worktreedel_test.go`

**Interfaces:**
- Produces:

```go
// worktreenew: every step of a create, in order, all StatusPending.
func Planned() []Step
// worktreedel: every step this delete will show, in order, all StatusPending.
func Planned(opts Options) []Step
```

- [ ] **Step 1: Write failing tests**
  - `worktreenew.TestPlannedMatchesOrder`: keys are `pull, create_worktree, allocate_ports, register, kubeconfig, resources, dotfiles`; every label non-empty; every status `pending`. (`cmux_workspace` is not in it.)
  - `worktreedel.TestPlannedFollowsDeleteBranch`: with `DeleteBranch: false` the keys are `remove_directory, release_ports, unregister, remove_resources, remove_kubeconfig, prune`; with `true`, `delete_branch` sits right after `remove_directory`.
  - `worktreedel.TestRunStepsMatchPlanned`: for an existing delete fixture in that file, `Run(...).Steps` has the same keys in the same order as `Planned(opts)`.
- [ ] **Step 2: Run** both packages' tests — FAIL.
- [ ] **Step 3: Implement.** `worktreedel.Run` builds its initial list by calling `Planned(opts)` (move the existing key logic, do not copy it). `worktreenew.Planned` walks `order`.
- [ ] **Step 4: Run** `go test ./internal/worktreenew/ ./internal/worktreedel/ ./cmd/` — PASS.
- [ ] **Step 5: Commit** `feat: runners expose their planned steps`.

---

### Task 4: Job kinds, routes and stream

**Files:**
- Create: `internal/webui/jobs_kinds.go`, `internal/webui/jobs_api.go`
- Modify: `internal/webui/worktree_create_api.go`, `internal/webui/worktree_delete_api.go`, `internal/webui/stream.go`, `internal/webui/server.go` (routes; `jobsOnce`/`jobsMgr` fields), `cmd/ui.go` (call `srv.RecoverJobs()` before `srv.Start()`)
- Test: `internal/webui/jobs_kinds_test.go`, `internal/webui/jobs_api_test.go`; rewrite `worktree_create_api_test.go` and `worktree_delete_api_test.go` to the new responses

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:

```go
// jobs_api.go
func (s *Server) jobs() *jobs.Manager   // lazy; registers both kinds; pid os.Getpid()
func (s *Server) RecoverJobs() error    // s.jobs().Recover()

const (
	jobKindCreate = "worktree_create"
	jobKindDelete = "worktree_delete"
)

type startJobResponse struct {
	Job      jobs.Job `json:"job"`
	Attached bool     `json:"attached"`
}
```

- Routes:

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `/api/worktrees/create` | as today | 400s as today; else 200 `startJobResponse` |
| POST | `/api/worktrees/delete` | as today | 400 missing path; else 200 `startJobResponse` |
| GET | `/api/jobs` | — | `{"jobs":[…]}`, never null |
| POST | `/api/jobs/answer` | `{id, answer}`, answer `"yes"` or `"no"` | the job; 400 other answer; 404; 409 `ErrWrongState` |
| POST | `/api/jobs/retry` | `{id}` | the job; 404; 409 |
| POST | `/api/jobs/dismiss` | `{id}` | 204; 404; 409 |

- Stream: right after the first heartbeat, `event: jobs` with `{"jobs":[…]}` (the `Subscribe` snapshot); then `event: job` with one job per change. When the changes channel closes (slow subscriber), the handler returns so the tab reconnects.

**Kind rules**

- Titles and targets: create — title `New worktree <trimmed input>`, target `<repo_root>\x00<trimmed input>`; delete — title `Delete worktree <filepath.Base(path)>`, target `path`.
- Step mapping (both kinds): a runner step reported `pending` through `observe` is the job step `running`; every other status keeps its name.
- **Create `Run`:** `s.createConfig()` error → `failed` with that error. Else `worktreenew.Run(s.DB, cfg, req.options(), observe)`. `res.Err` → `failed`, `Error` its text. `res.Confirm` → `needs_answer`, `Question` = the `Confirm` JSON. Otherwise `succeeded`, `Result` = `{"path":…,"branch":…}`.
- **Create `Answer`:** question key `reuse_branch`: yes → `reuse_branch=true`; no → end. Key `reset_to_pr`: yes → `reuse_branch=true, reset_to_pr=true`; no → `reuse_branch=true, decline_reset=true`.
- **Delete `Run`:** `config.Load()` error → `failed`. Else `worktreedel.Run`. `res.NeedsForce != ""` → `needs_answer`, `Question` = `{"key":"<step key>"}`. `res.Err != nil` or any step `failed` → `failed` (`Error` = `res.Err` text when set). Otherwise `succeeded`.
- **Delete `Answer`:** key `remove_directory`: yes → `force_directory=true`; no → end. Key `delete_branch`: yes → `force_branch=true`; no → `delete_branch=false` (cleanup still completes).
- Plans: create → `worktreenew.Planned()`; delete → `worktreedel.Planned(opts)`; both mapped to `jobs.Step`.

- [ ] **Step 1: Write failing kind tests** (`jobs_kinds_test.go`; call the kind functions directly, no HTTP):
  - `TestCreateAnswerTable`: the four question/answer pairs above produce exactly those flags (decode `next` into `createWorktreeRequest`), and `reuse_branch`+no gives `end=true`.
  - `TestDeleteAnswerTable`: the four pairs above; `delete_branch`+no gives `delete_branch=false`, `end=false`.
  - `TestDeleteKindRunsToSuccess` (uses `testgit.Worktree`, registered in the test DB as the existing delete tests do): run the kind; reports include `remove_directory` as `running` before `done`; outcome `succeeded`.
  - `TestDeleteKindDeclineBranchForceCompletes`: reuse the fixture behind `TestRunDeclineBranchForceStillCompletesCleanup`: run with `delete_branch=true` → `needs_answer` key `delete_branch`; `Answer(no)`; run `next` → `succeeded`, and the registry row is gone.
  - `TestCreateKindSucceedsWithResult` (`testgit` fixture, as the existing create tests): outcome `succeeded`, result has the created `path` and `branch`.
  - `TestCreateKindBadRepoRootFails`: outcome `failed`, `Error` contains `repo root not found`.
- [ ] **Step 2: Write failing API tests** (`jobs_api_test.go`, plus the two rewritten files):
  - `TestCreateWorktreeStartsJob`: POST create → 200, `job.kind == "worktree_create"`, `job.state == "running"` or already finished; after `s.jobs().Wait()`, `GET /api/jobs` shows it `succeeded` with a `result.path` that exists on disk.
  - `TestCreateWorktreeValidationStill400`: missing input, missing repo_root, a Slack URL, and an existing worktree path each give 400 and `GET /api/jobs` stays empty.
  - `TestDeleteWorktreeStartsJob`: POST delete → job; after `Wait`, state `succeeded` and the directory is gone.
  - `TestDeleteTwiceAttaches`: with a registered fake kind that blocks (register it on `s.jobs()` under the delete kind's name in the test), two POSTs return the same id and the second has `attached: true`.
  - `TestJobAnswerConflict`: answer on a running job → 409; answer `"maybe"` → 400; unknown id → 404.
  - `TestJobRetryAndDismissStates`: dismiss on running → 409; on failed → 204 and gone from `GET /api/jobs`; retry on succeeded → 409.
  - `TestStreamSendsJobsSnapshotFirst`: open `/api/stream` with one parked job saved; read events until `jobs`; its payload lists that job; then start another job and read a `job` event for it.
- [ ] **Step 3: Run** `go test ./internal/webui/ -run 'Job|CreateWorktree|DeleteWorktree|Stream'` — FAIL.
- [ ] **Step 4: Implement.** Delete `createWorktreeResponse` and `deleteWorktreeResponse`. The start handlers keep their validation, marshal the request struct as the job request, and call `s.jobs().Start`. In `stream.go`, subscribe before the first heartbeat is written and add the `changes` case to the `select`.
- [ ] **Step 5: Run** `go test -race ./internal/webui/ ./internal/jobs/` and `go test ./...` — PASS.
- [ ] **Step 6: Commit** `feat(webui): create and delete worktrees as background jobs`.

---

### Task 5: The cmux workspace as a create step

**Files:**
- Modify: `internal/webui/cmux_api.go`, `internal/webui/jobs_kinds.go`, `internal/webui/worktree_create_api.go`
- Test: `internal/webui/jobs_kinds_test.go`, existing `cmux_api_test.go`

**Interfaces:**
- Produces:

```go
// createWorktreeRequest gains:
WorkspaceName     string `json:"workspace_name"`
WorkspaceGroupRef string `json:"workspace_group_ref"`
WorkspaceColor    string `json:"workspace_color"`

// cmux_api.go — what handleCmuxCreate did after its guards, unchanged.
func (s *Server) createCmuxWorkspace(path, name, groupRef, color string) (ref string, err error)
```

**Rules**

- The step's key is `string(worktreenew.StepCmuxWorkspace)`, label `cmux workspace`. It is in the create plan (last) only when `workspace_name` is non-blank.
- After the runner returns without error or confirm, when the step is planned: report it `running`, then
  - `!s.cmuxEnabled()` → `skipped`, detail `cmux features are off`
  - `cmux.FindByDirectory(path)` finds a workspace → `skipped`, detail `already has a workspace`
  - `createCmuxWorkspace` fails → `failed`, detail the error; the outcome stays `succeeded`
  - else `done`, detail the workspace name.
- `handleCmuxCreate` calls `createCmuxWorkspace`; its responses do not change.

- [ ] **Step 1: Write failing tests** (serial — they stub cmux the way `cmux_api_test.go` does):
  - `TestCreatePlanAddsCmuxStepOnlyWithName`: plan for a request with `workspace_name: "ws"` ends with `cmux_workspace`; without it, the key is absent.
  - `TestCreateKindCmuxDisabledSkips`: cmux features off → step `skipped` / `cmux features are off`, outcome `succeeded`.
  - `TestCreateKindCmuxCreatesWorkspace`: stub records the `cmux` invocations → a new-workspace call carrying the name and cwd; step `done`.
  - `TestCreateKindCmuxExistingWorkspaceSkips`: stub lists a workspace at the worktree's path → `skipped` / `already has a workspace`, and no new-workspace call.
  - `TestCreateKindCmuxFailureIsStickySuccess`: stub fails the create → step `failed`, outcome `succeeded` (so the manager keeps it visible; assert `jobs.Job{Steps: …}.HasFailedStep()`).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test -race ./internal/webui/` — PASS.
- [ ] **Step 5: Commit** `feat(webui): create the cmux workspace as a job step`.

---

### Task 6: Refusing to stop

**Files:**
- Create: `internal/webui/stop.go`
- Modify: `cmd/ui.go`, `.air.toml`
- Test: `internal/webui/stop_test.go`

**Interfaces:**
- Produces:

```go
// stopForceWindow is how long after a refused signal a second one forces.
const stopForceWindow = 5 * time.Second

// GuardStop decides what each stop signal does, until sigs closes.
// No job running: exit(0). A job running: log and stay, unless a signal was
// already refused within stopForceWindow: then log and exit(1).
func (s *Server) GuardStop(sigs <-chan os.Signal, exit func(code int), now func() time.Time)
```

- Log lines (through `s.Logger`, exact):
  - refusal: `refusing to stop: <title>[, <title>…] is running; signal again within 5s to force`
  - forced: `forced stop: <title>[, <title>…] will be marked interrupted`
- `cmd/ui.go`, just before `srv.Start()`: `signal.Notify(ch, syscall.SIGTERM, os.Interrupt)` on a buffered channel and `go srv.GuardStop(ch, os.Exit, time.Now)`.
- `.air.toml`, under `[build]`: add `send_interrupt = false` with the comment `# Restart by killing outright: worktree ui refuses SIGINT while a job runs (internal/webui/stop.go). The killed job comes back "interrupted".`

- [ ] **Step 1: Write failing tests** (`t.Parallel()`; a fake kind that blocks until released; a fake clock; `exit` records its code and the test then closes `sigs`):
  - `TestGuardStopExitsWhenIdle`: one signal, no jobs → `exit(0)`.
  - `TestGuardStopRefusesWhileRunning`: one signal with a running job titled `Delete worktree foo` → no exit; the logger got the refusal line with that title.
  - `TestGuardStopSecondSignalForces`: second signal 2s later (fake clock) → `exit(1)` and the forced line.
  - `TestGuardStopSecondSignalAfterWindowRefusesAgain`: second signal 6s later → no exit, a second refusal line.
  - `TestGuardStopParkedJobDoesNotBlock`: only a `needs_answer` job → `exit(0)`.
  - `TestGuardStopExitsOnceJobFinishes`: refused, job released and `Wait`ed, then a signal 10s later → `exit(0)`.
- [ ] **Step 2: Run** `go test ./internal/webui/ -run GuardStop` — FAIL.
- [ ] **Step 3: Implement** `GuardStop` and the `cmd/ui.go` wiring; edit `.air.toml`.
- [ ] **Step 4: Verify air's restart.** Read air's kill routine in the module cache (`ls "$(go env GOMODCACHE)/github.com/air-verse/"` then `runner/util_unix.go`, or `go doc`/the README if not cached) and confirm that with `send_interrupt = false` the old process is killed with SIGKILL, not sent SIGINT/SIGTERM. If air is not installed or the source says otherwise, stop and report what it does instead of guessing.
- [ ] **Step 5: Run** `go test -race ./internal/webui/ && go build ./...` — PASS.
- [ ] **Step 6: Commit** `feat(ui): refuse to stop while a job is running`.

---

### Task 7: `worktree jobs` and the install prompt

**Files:**
- Create: `cmd/jobs.go`, `scripts/stop-running.sh` (mode 755)
- Modify: `Makefile` (`stop-running` target), `cmd/agent_help_test.go` (`skillReadCommands`)
- Test: `cmd/jobs_test.go`, `scripts/stop-running_test.sh`

**Interfaces:**
- Produces: `worktree jobs [--running] [--json]` (group `worktree`, `cobra.NoArgs`, always exits 0 on a readable DB).
  - Lists `jobs.Unfinished`. Each job is **live** when its state is `running` and its pid is alive (`syscall.Kill(pid, 0)` succeeds or fails with `EPERM`). `--running` keeps only live jobs.
  - `wdb.ErrNoDatabase` and `wdb.ErrSchemaBehind` from `OpenRead` mean no jobs: print the empty result, exit 0.
  - Plain output: one line per job, `<title> — <label of the running step, or the state when none>`; nothing at all when there are none.
  - JSON: `{"schema_version":1,"jobs":[{"id","kind","title","state","live","current_step","created_at"}]}`, `jobs` never null.
  - The pid check is a package var `pidAlive func(int) bool` in `cmd` so tests can drive it.

- `scripts/stop-running.sh <installed-binary-path> <built-binary-path> <server-cmd>...`, env `NONINTERACTIVE`. Write it as:

```sh
#!/bin/sh
# Stops running worktree servers before the binary is replaced. A server
# with a job in flight is never killed without asking.
set -u
target=$1; built=$2; shift 2
pattern="(^|/)$(basename "$target") ($(echo "$*" | tr ' ' '|'))(\$| )"

running_pids() {   # PIDs whose executable is exactly $target
	out=""
	for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
		exe=$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | awk '/^n/{print substr($0,2); exit}')
		[ "$exe" = "$target" ] && out="$out $pid"
	done
	echo $out
}
busy() { "$built" jobs --running 2>/dev/null || true; }

# ask prints the busy jobs and returns 0 to look again, 2 to force.
ask() {
	echo "worktree ui is busy:"
	echo "$1" | sed 's/^/  /'
	if [ -n "${NONINTERACTIVE:-}" ] || [ ! -r /dev/tty ]; then
		echo "Aborting: a job is running." >&2; exit 1
	fi
	while :; do
		printf '[A]bort, [R]etry, [F]orce? '
		read -r answer </dev/tty || exit 1
		case "$answer" in
			[Aa]*) echo "Aborted."; exit 1 ;;
			[Rr]*) return 0 ;;
			[Ff]*) return 2 ;;
		esac
	done
}

force=0
while :; do
	pids=$(running_pids)
	[ -z "$pids" ] && exit 0
	if [ "$force" = 1 ]; then
		echo "Force-killing $(basename "$target") server(s):$pids"
		kill -KILL $pids 2>/dev/null || true
		exit 0
	fi
	jobs=$(busy)
	if [ -n "$jobs" ]; then
		ask "$jobs"; [ $? = 2 ] && force=1
		continue
	fi
	echo "Stopping running $(basename "$target") server(s) [$target]:$pids"
	kill -TERM $pids 2>/dev/null || true
	sleep 2
	pids=$(running_pids)
	[ -z "$pids" ] && exit 0
	jobs=$(busy)
	if [ -n "$jobs" ]; then          # a job started in the gap; the server refused
		ask "$jobs"; [ $? = 2 ] && force=1
		continue
	fi
	echo "Force-killing remaining $(basename "$target") server(s):$pids"
	kill -KILL $pids 2>/dev/null || true
	exit 0
done
```

  (`ask` under `set -u` without `set -e`, so its non-zero return is readable.)

- `Makefile`: `stop-running` becomes a call to the script with the resolved install path (keep the existing `pwd -P` resolution of `INSTALL_DIR`), `$(BIN_DIR)/$(BINARY_NAME)`, and `$(SERVER_CMDS)`, passing `NONINTERACTIVE` through. `install` still depends on `build stop-running`, in that order.

- [ ] **Step 1: Write failing Go tests** (`cmd/jobs_test.go`, following how other `cmd` read-command tests point the DB at a temp dir and never read the real config):
  - `TestJobsListsUnfinished`: rows `running` (pid alive via stub), `needs_answer`, `failed` → plain output has two lines; the running one reads `Delete worktree foo — Remove worktree directory`; the parked one `New worktree x — needs_answer`.
  - `TestJobsRunningFiltersDeadPid`: a `running` row whose pid the stub reports dead → `--running` prints nothing.
  - `TestJobsJSONShape`: `--json` has `schema_version` 1, a `jobs` array, and `live` true/false as above; with no rows, `"jobs":[]`.
  - `TestJobsNoDatabase`: no DB file → exit 0, empty output.
- [ ] **Step 2: Write the failing script test** `scripts/stop-running_test.sh`: a POSIX sh script that builds a temp dir with fake `pgrep`, `lsof`, `kill`, `sleep` on `PATH` and a fake "built binary" whose `jobs --running` output is read from a file, then asserts (exit code + the `kill` log):
  - no server running → exit 0, no kill.
  - idle server → one `-TERM`, then (fake `pgrep` empties after TERM) exit 0.
  - busy server, `NONINTERACTIVE=1` → exit 1, no kill at all, output contains `worktree ui is busy:` and the job line.
  - idle at the check, still alive after TERM with a job now reported, `NONINTERACTIVE=1` → exit 1 and **no** `-KILL`.
  - alive after TERM with no job → `-KILL` (today's behaviour).
  The interactive branches (`/dev/tty`) are checked by hand in Step 6.
- [ ] **Step 3: Run** `go test ./cmd/ -run Jobs` and `sh scripts/stop-running_test.sh` — FAIL.
- [ ] **Step 4: Implement** `cmd/jobs.go`, add `"worktree jobs": true` to `skillReadCommands`, write the script, rewire the Makefile; add `sh scripts/stop-running_test.sh` to the `test` target.
- [ ] **Step 5: Run** `make test` — PASS.
- [ ] **Step 6: Do not run `make install` or the real script against the installed binary** — it would signal the human's running server. The interactive Abort/Retry/Force branches are on Task 12's manual check list for them.
- [ ] **Step 7: Commit** `feat: worktree jobs, and make install asks before stopping a busy server`.

---

### Task 8: Frontend job types, client, store and stream

**Files:**
- Modify: `ui/src/api/types.ts`, `ui/src/api/client.ts`, `ui/src/hooks/useSSE.ts`
- Create: `ui/src/lib/jobsStore.ts`
- Test: `ui/src/lib/jobsStore.test.ts`

**Interfaces:**
- Produces (`types.ts`; delete `CreateStep`, `CreateWorktreeResponse`, `DeleteStep`, `DeleteStepStatus`, `DeleteWorktreeResponse`; keep `CreateConfirm`):

```ts
export type JobState = "running" | "needs_answer" | "succeeded" | "failed" | "interrupted"
export type JobStepStatus = "pending" | "running" | "done" | "skipped" | "failed" | "needs_force"
export interface JobStep { key: string; label: string; status: JobStepStatus; detail?: string }
/** key is reuse_branch | reset_to_pr | remove_directory | delete_branch. */
export interface JobQuestion { key: string; branch?: string; local_head?: string; remote_head?: string }
export interface Job {
  id: string
  kind: "worktree_create" | "worktree_delete"
  title: string
  target: string
  state: JobState
  steps: JobStep[]
  question: JobQuestion | null
  result: { path?: string; branch?: string } | null
  error?: string
  created_at: string
  updated_at: string
  finished_at?: string
  dismissed?: boolean
}
export interface StartJobResponse { job: Job; attached: boolean }
```

- `client.ts`: `createWorktree` (args gain `workspace_name?`, `workspace_group_ref?`, `workspace_color?`; the answer flags are removed from its args) and `deleteWorktree` (force flags removed) return `Promise<StartJobResponse>`. New: `jobAnswer(id: string, answer: "yes" | "no"): Promise<Job>`, `jobRetry(id: string): Promise<Job>`, `jobDismiss(id: string): Promise<void>`.

- `jobsStore.ts` (same `useSyncExternalStore` pattern as `checksStore.ts`):

```ts
/** Replace everything: the stream's snapshot on (re)connect. */
export function setJobs(jobs: Job[]): void
/** Upsert one job; a dismissed job is removed. */
export function applyJob(job: Job): void
/** Oldest first. */
export function useJobs(): Job[]
export function useJob(id: string | undefined): Job | undefined
export function getJob(id: string): Job | undefined

/** Jobs a modal in THIS tab is showing; their toasts are hidden here. */
export function attachJob(id: string): () => void   // returns detach
export function useAttachedJobIds(): ReadonlySet<string>

/** A toast asks for a job's modal; JobModalHost answers. */
export function openJobModal(id: string): void
export function closeJobModal(): void
export function useOpenJobId(): string | undefined

export function isFinished(job: Job): boolean        // succeeded | failed | interrupted
export function currentStep(job: Job): JobStep | undefined   // the running step
```

- `useSSE.ts`: `jobs` event → `setJobs(payload.jobs)`; `job` event → `applyJob(job)`, and when `isFinished(job)` invalidate `["worktrees"]` and `["cmux"]`. Malformed payloads are ignored, as the other listeners do.

- [ ] **Step 1: Write failing tests** (`jobsStore.test.ts`; reset the store in `beforeEach` with `setJobs([])`):
  - `applyJob adds then updates by id` — two applies with the same id leave one job with the second's state.
  - `applyJob with dismissed removes the job`.
  - `setJobs replaces the store` — store holds A and B; `setJobs([B'])` leaves only B'.
  - `useJobs is oldest first` — by `created_at`.
  - `attachJob hides and the returned function shows again` — `useAttachedJobIds` (via `renderHook`) contains the id, then not.
  - `openJobModal / closeJobModal drive useOpenJobId`.
  - `currentStep is the running step, undefined when none`.
- [ ] **Step 2: Run** `npm test -- jobsStore` — FAIL.
- [ ] **Step 3: Implement** types, client, store, and the two stream listeners. The modals will not compile against the removed types yet: in this task, change only their imports and the minimum needed for `tsc -b` to pass (they are rewritten in Tasks 9 and 10), and mark their existing tests `describe.skip` with the comment `// rewritten in the next task`.
- [ ] **Step 4: Run** `npm test && npm run build` — PASS.
- [ ] **Step 5: Commit** `feat(ui): job types, client calls and store`.

---

### Task 9: `JobStepper` and the delete modal

**Files:**
- Create: `ui/src/components/jobs/JobStepper.tsx`
- Modify: `ui/src/components/DeleteWorktreeModal.tsx`
- Test: `ui/src/components/jobs/JobStepper.test.tsx`, `ui/src/components/DeleteWorktreeModal.test.tsx` (rewrite, un-skip)

**Interfaces:**
- Consumes: Task 8.
- Produces:

```tsx
export function JobStepper({ steps }: { steps: JobStep[] }): JSX.Element
// DeleteWorktreeModal gains one optional prop:
jobId?: string   // open on this existing job, skipping the confirmation form
// and when opened on a job, `path`/`name`/`branch` may be omitted.
```

**Rules**

- `JobStepper` is the delete modal's `StepRow` list, moved: `running` → `<Loader size={14} />` (give it `aria-label="In progress"`); `failed` / `needs_force` → red ✕ with the detail beneath in red, `white-space: pre-wrap`; `pending` → dimmed ○ and dimmed label; `done` / `skipped` → green check, a `skipped` detail in dimmed parentheses.
- The modal holds `jobId` in state (from the prop, or from the start response) and reads the job with `useJob`. It keeps the **last job it saw** so a job that expires from the store (clean success after ~10s) stays on screen.
- Submit: `api.deleteWorktree({ path, delete_branch })` → `setJobId(res.job.id)`. A request error shows in the existing red alert.
- While `opened` with a job id, `attachJob(id)` (detach on close/unmount).
- Body by state: no job → the form, as today. Job → title = `job.title`, `<JobStepper steps={job.steps} />`, then:
  - `needs_answer`: the existing hint for `remove_directory`; buttons **Cancel** → `api.jobAnswer(id, "no")` and **Force-remove the directory** / **Force-delete the branch** (by `job.question.key`) → `api.jobAnswer(id, "yes")`. After a "no" on `remove_directory` the job is dismissed: close the modal.
  - `failed` / `interrupted`: `job.error` in the red alert unless a step already shows it; **Run again** → `api.jobRetry(id)`; **OK**.
  - `succeeded`: **OK**.
  - `running`: a single **Close** button; the helper text `This keeps running if you close this window.`
- Closing the modal on a finished job calls `api.jobDismiss(id)` (ignore a 404/409 — it may already be gone). Closing on a running or parked job dismisses nothing.
- `onDeleted` is called when the user presses **OK** on a `succeeded` job; otherwise `onClose`.
- `useUnsavedChanges(opened && typed !== "" && !jobId)` — a running delete no longer blocks leaving.

- [ ] **Step 1: Write failing tests.** Mock `../api/client`; drive progress by calling `applyJob` inside `act`.
  - `JobStepper.test.tsx`: `shows a spinner on the running step only`; `shows a failed step's detail`; `dims pending steps`; `shows a skipped step's detail in parentheses`.
  - `DeleteWorktreeModal.test.tsx`:
    - `starts a job and shows its steps as they arrive` — type the name, click Delete; `deleteWorktree` called with `{path, delete_branch: false}`; apply a running job with one running step → "In progress" present; apply the next step done → check shown.
    - `closing while running leaves the job alone` — `jobDismiss` not called; `onClose` called.
    - `a force question answers yes` — parked job, key `remove_directory` → click "Force-remove the directory" → `jobAnswer(id, "yes")`.
    - `declining the branch force answers no and stays open` — key `delete_branch` → Cancel → `jobAnswer(id, "no")`; `onClose` not called.
    - `declining the directory force answers no and closes`.
    - `OK on success dismisses and reports deleted` — `jobDismiss(id)` and `onDeleted` called.
    - `keeps showing a job that left the store` — apply succeeded, then `applyJob({...job, dismissed: true})` → steps still on screen.
    - `a failed job offers Run again` → `jobRetry(id)`.
    - `opens straight on an existing job` — render with `jobId` of a parked job in the store → no name field; the force button present.
    - `hides its job's toast while open` — `useAttachedJobIds` (probe component) contains the id while opened, not after close.
- [ ] **Step 2: Run** `npm test -- JobStepper DeleteWorktreeModal` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run build` — PASS.
- [ ] **Step 5: Commit** `feat(ui): delete worktree modal follows a background job`.

---

### Task 10: The new-worktree modal

**Files:**
- Modify: `ui/src/components/NewWorktreeModal.tsx`
- Test: `ui/src/components/NewWorktreeModal.test.tsx` (rewrite, un-skip)

**Interfaces:**
- Consumes: Tasks 8–9 (`JobStepper`, store, client).
- Produces: `NewWorktreeModal` gains `jobId?: string` (open on an existing job, skipping the form).

**Rules**

- Same job plumbing as Task 9: `jobId` state, `useJob`, last-seen job kept, `attachJob` while open, dismiss on closing a finished job.
- Submit: `api.createWorktree({ input, repo_root, pull, copy_dotfiles, branch?, workspace_name?, workspace_group_ref?, workspace_color? })` — the workspace fields only when cmux is available and the name is non-blank. The modal no longer calls `api.cmuxCreate`.
- With a job: the form fields are hidden; show `job.title`, `<JobStepper>` (replacing the Mantine `Timeline`), and:
  - `needs_answer` — the existing yellow alert, text from `job.question` exactly as today. `reuse_branch`: **Cancel** → `jobAnswer(id, "no")` then close; **Reuse branch** → `"yes"`. `reset_to_pr`: **Keep current commit** → `"no"` (stays open; the job continues); **Reset to PR** → `"yes"`.
  - `failed` / `interrupted` — `job.error` in the red alert; **Run again**; **Close**.
  - `succeeded` — **OK** → dismiss, close, `navigate("/worktree/" + encodeURIComponent(job.result.path))`.
  - `running` — **Close** and `This keeps running if you close this window.`
- `useUnsavedChanges` ignores the form once a job exists.

- [ ] **Step 1: Write failing tests** (mock the client, `useCmux` as the existing test does; drive with `applyJob`):
  - `starts a job with the form's values` — including `workspace_name` / group / colour when cmux is available and a name is typed; none of the three when the name is blank.
  - `never calls cmuxCreate`.
  - `shows live steps` — running step has "In progress".
  - `reuse branch: yes answers yes; cancel answers no and closes`.
  - `reset to PR: Keep current commit answers no and stays open`.
  - `OK on success dismisses and navigates to the worktree` — assert location `/worktree/<encoded path>`.
  - `closing while running dismisses nothing`.
  - `opens straight on an existing job` — with `jobId`, the input field is absent and the stepper present.
- [ ] **Step 2: Run** `npm test -- NewWorktreeModal` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run build` — PASS.
- [ ] **Step 5: Commit** `feat(ui): new worktree modal follows a background job`.

---

### Task 11: Toast stack and modal host

**Files:**
- Create: `ui/src/components/jobs/JobToasts.tsx`, `ui/src/components/jobs/JobModalHost.tsx`
- Modify: `ui/src/App.tsx` (mount both inside `FullApp`'s `Router`; not in `MiniApp`)
- Test: `ui/src/components/jobs/JobToasts.test.tsx`, `ui/src/components/jobs/JobModalHost.test.tsx`

**Interfaces:**
- Consumes: Tasks 8–10.
- Produces: `<JobToasts />`, `<JobModalHost />` (no props).

**Rules**

- `JobToasts`: Mantine `Affix` at `{ bottom: 16, right: 16 }`, a `Stack` of one `Paper` (width 340, `withBorder`, `shadow="md"`) per job from `useJobs()` whose id is not in `useAttachedJobIds()`. Renders nothing when the list is empty. Each toast is `role="status"` with `aria-label={job.title}`.
- Header row: a `Loader size={14}` while `running`; the title; a collapse toggle (`aria-label` `Collapse` / `Expand`); and a close button (`aria-label="Dismiss"`) **only when `isFinished(job)`**.
- Collapsed (per job, `localStorage` key `worktree.jobs.collapsed.<id>`, wrapped in try/catch, default expanded): header plus one dimmed line — `currentStep(job)?.label`, or for other states the state line below.
- Expanded: `<JobStepper>` plus the state line and actions:

| State | Line | Actions |
|---|---|---|
| `running` | — | — |
| `needs_answer` | `Needs your answer: <headline>` in yellow | the whole toast is clickable → `openJobModal(job.id)` |
| `succeeded` | — (failed steps show in the stepper) | create with `result.path`: **Open worktree** → navigate, then dismiss |
| `failed` | `job.error` when no step shows it | **Run again** → `jobRetry` |
| `interrupted` | `Interrupted: the server stopped` | **Run again** → `jobRetry` |

  Headlines by `question.key`: `reuse_branch` → `reuse existing branch?`; `reset_to_pr` → `reset to the PR's latest?`; `remove_directory` → `force-remove the directory?`; `delete_branch` → `force-delete the branch?`.
- Dismiss → `api.jobDismiss(id)`; the toast leaves when the stream says so (no optimistic removal — the store is the server's).
- `JobModalHost`: reads `useOpenJobId()` and `getJob`; renders `NewWorktreeModal` or `DeleteWorktreeModal` by `job.kind` with `opened`, `jobId`, `onClose={closeJobModal}` (and for delete, `onDeleted={closeJobModal}`). Renders nothing when no job is open or the id is unknown.

- [ ] **Step 1: Write failing tests**
  - `JobToasts.test.tsx`:
    - `renders nothing with no jobs`.
    - `shows one toast per job, oldest first`.
    - `a running job has no dismiss button; a failed one does` (query by `aria-label="Dismiss"`).
    - `a needs_answer job has no dismiss button and opens its modal on click` — `useOpenJobId` becomes its id.
    - `collapsing shows only the current step's label and survives a remount` (localStorage).
    - `hides a job attached to a modal in this tab`.
    - `dismiss calls the API and does not remove the toast itself`.
    - `an interrupted job offers Run again` → `jobRetry`.
    - `a succeeded create offers Open worktree` → navigates to `/worktree/<encoded path>` and calls `jobDismiss`.
    - `a succeeded job with a failed step shows that step's detail`.
  - `JobModalHost.test.tsx`: `opens the delete modal on a delete job`; `opens the new-worktree modal on a create job`; `renders nothing for an unknown id`.
- [ ] **Step 2: Run** `npm test -- JobToasts JobModalHost` — FAIL.
- [ ] **Step 3: Implement** and mount.
- [ ] **Step 4: Run** `npm test && npm run build` — PASS.
- [ ] **Step 5: Commit** `feat(ui): job toast stack in every tab`.

---

### Task 12: Docs and end-to-end check

**Files:**
- Modify: `docs/web-ui-architecture.md`, `.claude/CLAUDE.md`

- [ ] **Step 1: `docs/web-ui-architecture.md`.**
  - New section `## Background jobs` after "Delete worktree": the job model and states, the one-per-target rule, what yes/no means per question (the table from Task 4's kind rules), expiry and dismissal, `Recover`, the atomic `Subscribe`, the cmux workspace step, refusing to stop and the second-signal force, `make install`'s prompt, and that air must kill outright (`send_interrupt = false`).
  - HTTP API table: the changed create/delete rows and the four `/api/jobs*` rows.
  - "SSE" section: the `jobs` and `job` events.
  - "`internal/worktreenew` step semantics": note that the job layer resolves the `pending` overload into `running`, and that the modal no longer replays requests itself.
  - "Delete worktree": replace the response description with the job flow.
  - "Frontend structure": `lib/jobsStore.ts`, `components/jobs/`.
- [ ] **Step 2: `.claude/CLAUDE.md`.** Add `jobs` to the `internal/` package list (one entry in the existing style: what it owns, that the manager is per-`Server`, the atomic subscribe, that adding a kind is one `jobs.Kind` registered in `webui/jobs_kinds.go`); mention `/api/jobs*` and the stream events in the `webui` entry; in "Build & Test", note that `make install` prompts Abort/Retry/Force when a job is running and aborts under `NONINTERACTIVE=1`; add `worktree jobs` to the read-commands sentence.
- [ ] **Step 3: Full verification.** `make build && make test && go test -race ./internal/webui/ ./internal/jobs/` — all PASS. Paste the tail of each into the report.
- [ ] **Step 4: Manual check list for the human** (do not run a second server against their DB, and never stop their running `worktree ui` or mprocs yourself). Hand over this list in the final report:
  1. `make install`, then delete a throwaway worktree: steps fill in live in the modal.
  2. Start a create on a PR, close the modal: the toast appears with a spinner on the current step; reload — still there; open a second tab — there too.
  3. Trigger a force question with the modal closed: the toast asks; clicking it opens the modal on the job.
  4. Run `make install` during a job: the Abort/Retry/Force prompt appears; Retry after it finishes proceeds; Force leaves an "Interrupted" toast with a working "Run again".
  5. `kill -TERM` the server during a job: it logs the refusal; a second signal within 5s stops it.
  6. `make dev`, save a Go file during a job: air restarts, the job comes back interrupted.
- [ ] **Step 5: Commit** `docs: background jobs`.
