# Background jobs with streaming progress

## Intent

Creating and deleting a worktree from the web UI are slow, and today each is
one blocking HTTP request: the modal spins with no progress until the whole
run is over, then shows a stepper of what already happened. If the page is
closed, reloaded, or put to sleep by cmux mid-run, the request's answer is
lost and there is no way to tell whether the worktree is still being deleted.

This change makes those actions **jobs** that run in the server, independent
of any page. Progress streams step by step. Whoever is looking — the modal
that started it, another browser tab, the same tab after a reload — sees the
same live state.

Create and delete are the first two job kinds. The mechanism must make a
third kind cheap to add.

**Naming:** "tasks" already means to-do items in this codebase
(`internal/tasks`). These are **jobs** everywhere: package, table, routes,
events, UI copy.

## Goals

- Create and delete start a job and return at once; the run continues with no
  page open.
- The modal that started a job shows its steps filling in live.
- Every other view of the app shows a stack of job toasts in a corner: same
  stepper, a spinner in the dot of the current step, collapsible, not
  dismissable while the job is unfinished.
- The stack survives reload and is the same in every browser tab and every
  logged-in device.
- A job that needs an answer (reuse branch, reset to PR, force) waits for it,
  and says so in its toast.
- A server that died mid-job leaves an "interrupted" job the user can run
  again.
- The server does not stop while a job is executing, and `make install` asks
  what to do rather than killing it.

## Non-goals

- Cancelling a running job.
- Showing CLI-started runs (`wt add`, `wt delete`) as jobs. The CLI keeps
  calling the runners directly, unchanged.
- Jobs in the mini view / menu bar app.
- A job history view. Finished jobs are shown until dismissed, then gone.

## Anti-goals

- A job's state that only one tab knows. If it is not in the server, it is
  not state.
- A toast stuck forever on a job that is not running. Every path out of
  "running" (finish, fail, question, server death) must land in a state the
  user can clear.
- The server reporting "stopped" for a job it killed. Force-stopping is
  allowed, but the job must come back as interrupted.

## Approaches considered

1. **Server-owned jobs, pushed whole over `/api/stream` — chosen.** A job
   manager in the server runs each job in a goroutine, persists the job row
   on every change, and pushes the full job to every open stream, with a
   snapshot of all visible jobs when a stream connects. The modal and the
   toast stack render from one client store. Same shape as
   `listeners_changed`. Reuses the connection every tab already holds, and a
   reconnect (reload, cmux wake) heals itself from the snapshot.
2. **DB as the only truth; the stream sends a bare `jobs_changed`** and tabs
   refetch `GET /api/jobs`, as `tasks_changed` does. Could show CLI-started
   runs. Rejected: a refetch per step per tab, and CLI runs would need
   liveness tracking to avoid stuck toasts — for a non-goal.
3. **A dedicated stream per job.** Clean for the modal, but the toast stack
   needs an all-jobs feed anyway, so it would duplicate (1).

## Design

### Job model

A job has:

- `id`, `kind` (`worktree_create` | `worktree_delete`), `title` (e.g.
  "Delete worktree foo", "New worktree RHOAIENG-123")
- `target` — what it operates on, for the one-job-per-target rule: the
  worktree path for delete; repo root + input for create
- `request` — the kind's full request body, stored so the job can be
  replayed (answer, run again)
- `state`: `running` | `needs_answer` | `succeeded` | `failed` | `interrupted`
- `steps`: `[{key, label, status, detail}]`
- `question` — present in `needs_answer`: the create runner's `Confirm`, or
  delete's `needs_force` step key (git's refusal output is already that
  step's `detail`)
- `result` — kind-specific outcome (create: `path`, `branch`), `error`
- timestamps: created, updated, finished, dismissed
- the server process's pid, for the stop check below

**Step status in a job is unambiguous.** The runners overload `pending`
(in flight vs never reached; see "`internal/worktreenew` step semantics").
The job layer resolves this once, so no client has to: a step reported as
started is `running`; one not yet reached is `pending`. The job's step list
shows every planned step from the moment it starts, unreached ones greyed.

**State transitions**

```
            start / answer / run again
                      │
                      ▼
                  running ──────────► succeeded
                 │   │   │
   runner asks ◄─┘   │   └─► failed
   needs_answer      │
                     └─► interrupted   (server died; set at next startup)
```

- A run that returns a confirmation or `needs_force` parks the job in
  `needs_answer`. Nothing executes while parked.
- **Answering** replays the stored request with the answer's flag set
  (`reuse_branch`, `reset_to_pr`, `decline_reset`, `force_directory`,
  `force_branch`) under the same job id. This is the existing replay model:
  every step is idempotent and done work reports as skipped. The step list
  resets for the new run.
- **Declining** is also an answer, sent to `/api/jobs/answer`; the server,
  not the modal, decides what a "no" means for each question:
  - reuse branch, force-remove directory: nothing has been changed yet that
    needs finishing. The job ends and is dismissed.
  - reset to PR: replays with `decline_reset`, as today.
  - force-delete branch: the directory is already gone, so ending here would
    strand the port range, registry row, resources and kubeconfig. It
    replays with `delete_branch: false` (what `cancelEscalation` does today;
    `TestRunDeclineBranchForceStillCompletesCleanup` pins the runner side).
    The stored request is rewritten, so a later "Run again" does not try the
    branch again, and the job ends `succeeded` with the branch kept.
- **A create whose worktree exists but a later step failed** (ports,
  register, kubeconfig, resources, dotfiles — the runner returns no error
  for these) ends `succeeded`, but is **sticky**: it does not expire on its
  own, shows the failed steps and their detail, and still offers "Open
  worktree". Any `succeeded` job with a failed step is sticky. *(My call.)*
- **Run again** on a `failed` or `interrupted` job replays its stored
  request, answers included, under the same id.
- A delete with a failed non-fatal step (cleanup) ends `failed`, as today's
  `ok:false`.

**One unfinished job per target.** Starting a job whose target already has a
`running` or `needs_answer` job does not start a second: the response names
the existing job and the modal attaches to it.

### The cmux workspace becomes a job step

Today `NewWorktreeModal` creates the cmux workspace itself, in the browser,
after the create returns (`api.cmuxCreate` with the form's name, group and
colour). Left there, a page closed mid-run would silently skip it.

The create job does it instead, as a final "cmux workspace" step
(`worktreenew.StepCmuxWorkspace` already has the label and is otherwise
unused):

- The create request gains the workspace fields the modal sends to
  `cmuxCreate` today; no name means no workspace, as now.
- The step lives in the webui's create adapter, after the shared runner
  returns — not in `worktreenew`, so `wt add` is unchanged.
- It is skipped when `s.cmuxEnabled()` is false, and when the worktree
  already has a workspace (`cmux.Match`), so a replay never makes a second.
- A failure is a failed step on a `succeeded` job (sticky, per above): the
  worktree exists.

### Server

`internal/jobs` (new): the manager and the store. Pure of HTTP. The manager
is a field on `webui.Server`, never a package global.

- Persistence: a `jobs` table in worktree's DB (bump `schemaVersion`). The
  row is rewritten on every step change — a job has under ten steps, so this
  is cheap.
- A kind is registered as: how to derive title and target from a request,
  and a run function that drives the runner with an `observe` callback and
  maps its `Result` to a job outcome. The create/delete adapters live in
  `internal/webui` beside today's handlers, because they need the server's
  config gates (`createConfig`).
- On every change the manager notifies subscribers; `stream.go` forwards
  each as an SSE event.
- **Startup:** every row still `running` becomes `interrupted`. No server
  was alive to be running it.
- **Retention:** dismissed jobs are deleted. (Builder may keep them briefly
  if that is simpler; nothing reads them.)

**Routes**

| Method | Path | Notes |
|---|---|---|
| POST | `/api/worktrees/create` | today's body plus the cmux workspace fields. Validation failures stay 400 and create no job. Otherwise returns `{job}` at once. |
| POST | `/api/worktrees/delete` | same body; returns `{job}` at once. |
| GET | `/api/jobs` | `{jobs: [...]}` — every visible job. For first paint before the stream connects. |
| POST | `/api/jobs/answer` | `{id, answer}` — yes or no to the job's question; only in `needs_answer`; 409 otherwise. |
| POST | `/api/jobs/retry` | `{id}` — only `failed` / `interrupted`; 409 otherwise. |
| POST | `/api/jobs/dismiss` | `{id}` — only finished states (`succeeded`, `failed`, `interrupted`); 409 while `running` or `needs_answer`. |

The old synchronous response shapes (`createWorktreeResponse`,
`deleteWorktreeResponse`) go away; nothing else consumes them.

**Stream:** `/api/stream` sends `event: job` with one full job as data
whenever a job changes (including dismissal, so tabs drop it), and one such
event per visible job on connect. `/mini`'s stream may ignore them.

**Visible** means: not dismissed, and not a clean `succeeded` job (no failed
step) that finished more than ~10 seconds ago. Success expiring on the server, not in the tab,
is what stops a faded toast from reappearing on reload.

Jobs are global to the server, not per login session: this is a single-user
tool and "all tabs" includes the phone.

### Refusing to stop

The server has no signal handling today; SIGTERM kills it.

- `worktree ui` handles SIGTERM and SIGINT. If any job is `running`, it logs
  one line naming them ("refusing to stop: Delete worktree foo is running")
  and carries on. Otherwise it exits as it does now. `needs_answer` jobs do
  not hold the server up: their state is in the DB and they are still asking
  after the restart.
- **A second signal within ~5 seconds forces the stop.** The refusal line
  says so ("…; signal again to force"). The server then exits and the job
  comes back `interrupted`. This is the escape from a hung job (jobs have no
  time limit and cannot be cancelled) that does not need a pid.
- SIGKILL and crashes cannot be refused; that is what `interrupted` is for.
- **`make dev`:** `air` restarts the server on every Go save. The plan must
  check how `air` signals (and the Makefile's own kill of the port holder)
  and make sure a restart during a job ends with the new server up and the
  job `interrupted`, never a refused restart and a failed rebind.

**`make install` (`stop-running`)**

Before signalling, it asks whether any job is running, using a new
read-only CLI command, `worktree jobs` (`--json`; lists unfinished jobs). A
job counts as running only if its row says `running` **and** the recorded
server pid is alive — so a crashed server's stale rows never block an
install. The check runs the freshly built `bin/worktree`, not the installed
binary (which may predate the command); a DB with no `jobs` table means no
jobs.

If jobs are running it prints them and prompts:

```
worktree ui is busy:
  Delete worktree foo — Remove worktree directory
[A]bort, [R]etry, [F]orce?
```

- **Abort** — stop the install, non-zero exit, nothing changed.
- **Retry** — ask again; back to this prompt if still busy, otherwise
  proceed.
- **Force** — SIGKILL the server and proceed. The job comes back
  `interrupted` when the new server starts.

`stop-running` sends exactly one SIGTERM, so it never trips the
second-signal force. If the check passes but the server survives SIGTERM (a
job started in the gap), it returns to the same prompt instead of
force-killing as it does today. With `NONINTERACTIVE=1` there is nobody to ask: it aborts. *(My
call.)*

`worktree jobs` follows the CLI rules: `printJSON`, read-only via
`OpenRead`, added to `skillReadCommands`.

### Frontend

One store (`lib/jobsStore.ts`, like `checksStore`) holds jobs by id, fed by
`GET /api/jobs` on load and `job` events from `useSSE`. Everything below
renders from it. Nothing about a job's progress lives in component state.

**`JobStepper`** — one component for both the modal and the toast: the step
list, a spinner in the dot of the `running` step, failed/needs-force steps
showing their detail. Replaces the two modals' separate step rendering.

**Modals.** `NewWorktreeModal` and `DeleteWorktreeModal` keep their forms.
Submitting posts, gets a job, and the modal then shows that job from the
store — live steps, the question when one is raised, the final result. The
existing confirmation UI stays, but its buttons call `/api/jobs/answer`
rather than re-posting. Closing the modal at any point leaves the job
running; that is the point. A modal can also be opened *on an existing job*
(from a toast), skipping the form.

**Toast stack** — mounted once at the app root (not in `/mini`), bottom
corner, one toast per visible job, except a job whose modal is open in this
tab.

```
┌──────────────────────────────────────┐
│ Delete worktree foo                ⌃ │
│  ✓ Remove worktree directory         │
│  ◌ Delete branch          (spinner)  │
│  ○ Release port range                │
│  ○ Unregister worktree               │
└──────────────────────────────────────┘
┌──────────────────────────────────────┐
│ ◌ New worktree RHOAIENG-123        ⌄ │   collapsed: title + current step
│   Create worktree                    │
└──────────────────────────────────────┘
```

| State | Toast |
|---|---|
| `running` | stepper, collapse toggle, no close button |
| `needs_answer` | highlighted; the question's headline ("Needs your answer: force remove?"); clicking opens the modal on this job. No close button — answer or decline in the modal |
| `succeeded` | all steps done; close button; goes away on its own (server expiry). A create offers "Open worktree" |
| `failed` | failed step and detail; "Run again"; close button |
| `interrupted` | "Interrupted — the server stopped"; "Run again"; close button |

Close calls `/api/jobs/dismiss`, so it clears everywhere. Collapsed/expanded
is a per-browser convenience (localStorage).

When a job succeeds, the same queries are invalidated as today
(`["worktrees"]` etc.) — in every tab, since every tab sees the event. A tab
sitting on a just-deleted worktree's page behaves as it does today when a
worktree disappears underneath it.

## Constraints

- Go tests in `internal/webui` are parallel: the manager is per-`Server`,
  and the signal handler needs a seam so tests never send real signals.
- `internal/worktreenew` / `worktreedel` runners are shared with the CLI and
  must not change behaviour for it.
- New read logic for `worktree jobs` goes in a method both the handler and
  the CLI call (`cmd/headless.go` pattern).
- `docs/web-ui-architecture.md` and `.claude/CLAUDE.md` are updated in the
  same change.

## Left to the builder

- Table columns and JSON encoding of steps/question/result.
- The answer payload's exact shape, and how kinds declare their answers.
- How the modal-on-an-existing-job is mounted so a toast can open it from
  any page.
- Exact success-expiry interval, toast placement relative to existing
  Mantine notifications (`UndoToast`), and copy.
- How the create runner exposes its planned steps up front (delete already
  prefills them).
