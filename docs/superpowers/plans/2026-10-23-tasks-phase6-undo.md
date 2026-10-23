# Tasks Phase 6 — Undo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Changing a task's state, checking or unchecking a subtask, and deleting a task each show the existing undo toast (10s, Undo or Z). Undo puts back exactly what the write changed, including what it set off (blockers it resolved), and refuses with 409 if something changed since. Deleted tasks are purged on a later sweep.

**Architecture:**
- **Undo by event id.** Every undoable write already records one task event. Phase 6 makes that event's payload self-sufficient for undo: from/to, the previous timestamps, and the cascade, i.e. the blocker ids it resolved and the event ids of those resolutions. The undo token is just the event id. The server derives everything to restore from the event, so a client can't forge what gets restored.
- **One transaction.** Task-kind blocker resolutions move INTO the state-change and delete transactions, so a write and everything it sets off commit together and can be undone together. Holds stay derived: `ReconcileHolds` runs after the undo.
- **Purge.** A webui sweep purges tasks soft-deleted more than an hour ago.

**Tech Stack:** Go, React + Mantine (`showUndoToast` in `ui/src/components/UndoToast.tsx`).

**Spec:** `docs/superpowers/specs/2026-10-21-tasks-design.md`, section "Undo", plus the "Unblocked" delay already built in Phase 5. The tracker is the spec's "Phases" table: set Phase 6 to "done" in the final commit. Record decisions in `docs/superpowers/specs/2026-10-21-tasks-autonomous-decisions.md` under "Phase 6".

## Global Constraints

- **Undoable writes:**
  - task state changes, from every surface (row checkbox menu, modal header, sidebar select)
  - subtask check and uncheck
  - task delete

  Nothing else is undoable in this phase. A write that changed nothing offers no undo, because it has no event.
- **Token.** The undo token is the id of the event the write recorded (`task_state_changed`, `subtask_checked`/`subtask_unchecked`, or `task_deleted`). The web responses carry `undo_event_id`, omitted when nothing changed.
- **Compare-and-swap (CAS).** Undo applies only while:
  - the event still exists
  - it is the task's newest event of its family (state: no newer `task_state_changed`; subtask: no newer check event for that subtask; delete: the task is still deleted with the same `deleted_at`)
  - the current value equals the event's "to"

  Otherwise it returns `ErrUndoConflict`, which the web layer maps to 409 with a readable message such as "The task changed since; nothing was undone." It reports the conflict and never retries.
- **What undo restores:**
  - A state change: the state, `started_at` and `completed_at`, all taken from the event payload's previous values.
  - A subtask check: the checked flag.
  - A delete: clears `deleted_at`.
- **Undo removes history.** It DELETES the event it reverses, and every cascaded event, in the same transaction. It writes no "reverted" event. It bumps the version, so SSE refreshes.
- **Cascades.**
  - Completing a task resolves, in the SAME transaction, every unresolved task-kind blocker whose blocking task is this task, writing `system` `task_blocker_resolved` events with reason "done".
  - Deleting a task does the same with reason "deleted".
  - The state-change or delete event's payload lists `cascade: [{blocker_id, event_id}]`.
  - Undo puts each such blocker back to unresolved, but only if it is still auto-resolved by that same event. It deletes the cascade events and writes no unresolve events.
  - Holds are derived, so `ReconcileHolds` runs after the undo commits.
  - The Phase 5 Unblocked notifier already holds notifications for 10s and drops one whose event is gone, so an undone completion never notifies.
  - Phase 5's after-commit `resolveAfterWrite` stays for resource kinds and the poll. Task kinds are now handled in the transaction; the after-commit pass must find nothing left to do for them.
- **Cascades go both ways (from the Phase 5 final review).**
  - LEAVING done (done → in progress or not started) also cascades inside the transaction. It unresolves the task-kind blockers that this task's completion had auto-resolved, writes `system` `task_blocker_unresolved` events, and lists them in the state event's `cascade`.
  - Undoing that reopen puts those blockers back to resolved WITHOUT writing new events and without notifying. It does this by restoring the earlier resolve's `resolved_at`/`resolved_auto`/`resolved_reason` and `resolved_event_id`, which the cascade entry records.
  - So an undone reopen never sends a spurious "Unblocked".
- **Exact cascade matching.**
  - `setResolvedTx` returns the event id it wrote.
  - `task_blockers` gains a nullable `resolved_event_id` column (via `addColumnIfMissing`).
  - "Only if still auto-resolved by that same event" is then an exact `resolved_event_id` match, not a timestamp heuristic.
- **Undo window alignment (from the Phase 5 final review).**
  - Mantine pauses a notification's auto-close while it is hovered, so an undo toast can outlive 10s. Make the undo toast end at a fixed deadline: disable the hover pause, or close it with a timer at `UNDO_WINDOW_MS` whatever happens.
  - The server's Unblocked hold becomes `UNDO_WINDOW_MS + 5s`, which allows for the notifier's 5s scan. Keep the constant and the comment linking the two.
  - An undo request that arrives after the toast deadline is still honoured if it passes CAS. The only guarantee is that a successful undo through the toast happens before any notification is sent.
- **Soft delete and purge.** `Delete` already soft-deletes. `PurgeDeleted(conn, olderThan time.Duration) (int, error)` hard-deletes tasks whose `deleted_at` is older than the cutoff. That removes, by cascade, their links, subtasks, blockers and event links. It also deletes their `task_events`, their `resource_read_cursor` rows (`resource_type = 'task'`) and their `task:<id>` hold subscriptions, live or tombstoned. Blockers in OTHER tasks that point at a purged task keep their row: `blocking_task_id` dangles, and their label falls back to "T<id> (deleted)".
  - The webui sweep runs every 5 minutes and purges anything deleted more than 1 hour ago. That is far beyond the 10s undo window, so an in-flight undo never meets a purged row.
  - The CLI doesn't purge.
- **CLI.** `worktree tasks state` and `delete` also print the undo event id in `--json` output (`undo_event_id`), and a new `worktree tasks undo <event-id>` calls the same undo. This lets agents undo their own mistakes.
- **UI.** `showUndoToast`:
  - Messages: `Marked “<title>” done` / `in progress` / `not started`; `Checked “<subtask>”` / `Unchecked “<subtask>”`; `Deleted “<title>”`.
  - Undo calls the matching undo endpoint, and the existing failure toast reports a 409.
  - Undoing a delete also reopens the task modal if the delete came from the modal.
  - The modal's inline "Delete? Yes / No" confirmation is REMOVED: delete is now one click, with undo.
- Commits: `git commit --signoff`, with trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01HAFCNa6UnHnRzp1mmxFzto`. Add files by name. Write `./cmd/...` in `go test`, never `./cmd/`. Don't merge to main, push, or touch `~/git/watcher`.

## Review Focus

1. **Undoing a completion that unblocked another task:** the other task's blocker is unresolved again, both events are gone, and no Unblocked notification is sent. Test (Tasks 1 and 3).
2. **An agent changes the task between your click and your Undo:** 409, nothing restored. Test (Task 1).
3. **Undo after the same task was changed twice:** undoing the older change is refused. Only the newest is undoable. Test (Task 1).
4. **Deleting then undoing a task that had unread agent events:** the unread events come back, with no new notification. Test (Tasks 1 and 3).
5. **Purge never touches a task deleted within the last hour, or one that was un-deleted.** Test (Task 2).

---

### Task 1: Undo in `internal/tasks`, with in-transaction cascades

**Files:**
- Modify: `internal/tasks/tasks.go` (`SetState` and `Delete` resolve task-kind blockers in-tx through internal helpers; the payloads gain the previous timestamps and `cascade`; `Delete` returns its event id, already done in Phase 1)
- Modify: `internal/tasks/resolve.go` (factor out an in-tx helper that resolves the task-kind blockers pointing at a task; the after-commit task-kind path becomes a no-op for writes that already did it)
- Modify: `internal/tasks/subtasks.go` (the payload carries from/to)
- Modify: `internal/db/migrate.go` (`task_blockers.resolved_event_id`), and `internal/tasks/blockers.go` (`setResolvedTx` returns the event id and records `resolved_event_id`). The cascade goes both ways: completing resolves, and leaving done unresolves. See Global Constraints.
- Modify: `internal/webui/notify_unblock.go` (hold = `UNDO_WINDOW_MS + 5s`)
- Create: `internal/tasks/undo.go`, `internal/tasks/undo_test.go`

```go
var ErrUndoConflict = errors.New("changed since; nothing was undone")
func UndoStateChange(conn *sql.DB, a Actor, taskID, eventID int64) error
func UndoSubtaskCheck(conn *sql.DB, a Actor, subtaskID, eventID int64) error
func UndoDelete(conn *sql.DB, a Actor, taskID, eventID int64) error
func Undo(conn *sql.DB, a Actor, eventID int64) error // dispatches on the event's type; the CLI uses this
```

Each runs in one `inTx` (never calling public functions inside it), then calls `reconcileHoldsAfterWrite`. It validates that the event belongs to the task or subtask. `ErrNotFound` means the event or task is missing. `ErrInvalid` means the event type isn't undoable.

- [ ] **Steps 1–5:** TDD. Test every Global Constraint bullet:
  - the restore values
  - the deleted events
  - a cascade put back and its events deleted
  - a cascade blocker since resolved by hand is left alone
  - CAS conflicts: a newer change, a value changed, the event already undone
  - the version bump
  - the `ErrInvalid` / `ErrNotFound` paths

  Also check that the Phase 5 resolver tests still pass, and that an in-tx resolution makes `resolveAfterWrite` a no-op for task kinds. Run `go test ./internal/... ./cmd/...`. Commit with subject `feat(tasks): undo state changes, subtask checks and deletes by event id`.

---

### Task 2: Purge sweep

**Files:**
- Create: `internal/tasks/purge.go`, `internal/tasks/purge_test.go` (`PurgeDeleted`)
- Modify: `internal/webui/poller.go` (or wherever a periodic loop fits) to run the sweep every 5 minutes with a 1-hour cutoff. Make both values constants with comments.
- Modify: blocker label code in `internal/webui/tasks_blockers_api.go`, so a dangling `blocking_task_id` reads "T<id> (deleted)".

- [ ] **Steps 1–5:** TDD. Tests:
  - a task deleted 2h ago is purged along with its children, events and cursor
  - a task deleted 5 min ago is kept
  - an un-deleted task is kept
  - another task's blocker pointing at a purged task keeps its row, and its label falls back
  - the sweep runs on the loop (use a seam)

  Commit with subject `feat(tasks): purge soft-deleted tasks after an hour`.

---

### Task 3: Undo endpoints and CLI

**Files:**
- Modify: `internal/webui/tasks_api.go` and `tasks_detail_api.go`
  - `/api/tasks/state`, `/api/tasks/subtasks/check` and `/api/tasks/delete` responses gain `undo_event_id` (omitempty). Delete returns `{undo_event_id}` instead of 204. Update the TS type in Task 4.
  - New routes: `POST /api/tasks/undo {event_id}` returns 204, 409 on `ErrUndoConflict`, 404 or 400 as mapped. Run `afterTaskWrite()` after an undo.
- Modify: `cmd/tasks.go`
  - `state` and `delete` `--json` include `undo_event_id`.
  - New `tasks undo <event-id>`. The human output is "Undone." or the conflict message, with exit code 1 on conflict.
- Modify: `docs/web-ui-architecture.md` (API rows plus a short "Undo for tasks" paragraph next to the existing "Undo" section), and the README tasks section (`tasks undo`).
- [ ] **Steps 1–5:** TDD. Tests for each endpoint:
  - `undo_event_id` present only when something changed
  - undo 204 and 409
  - a completion with a cascade, undone through the API: no Unblocked notification goes out (drive the notifier with the injectable hold)
  - the CLI `--json` field, and `tasks undo`

  Commit with subject `feat(webui,cli): undo endpoints for task state, subtask checks and deletes`.

---

### Task 4: Undo toasts in the UI

**Files:**
- Modify: `ui/src/api/types.ts` and `client.ts` (`undo_event_id`; `api.undoTask(eventId)`; the delete response type)
- Modify: `ui/src/components/UndoToast.tsx`. The toast ends at a fixed `UNDO_WINDOW_MS` deadline, so hovering doesn't extend it. That applies to every undo toast, including the existing mark-read ones. Add a test.
- Modify: `ui/src/hooks/useTasks.ts` and `useTaskDetail.ts` (return `undo_event_id` from `setState`, `checkSubtask` and `remove`)
- Modify:
  - `ui/src/components/tasks/TaskList.tsx` and `TaskRow` wiring, for row state changes
  - `modal/TaskModalHeader.tsx`, `TaskSidebar.tsx`, `SubtasksSection.tsx` and `TaskDetailModal.tsx`
  - Each calls `showUndoToast({message, undo: () => api.undoTask(id), onSettled: invalidate})` when an `undo_event_id` comes back.
  - Remove the inline "Delete? Yes / No". Undoing a delete made from the modal reopens the modal: `open(id)`.
- Test: the corresponding test files.
- [ ] **Steps 1–5:** TDD. Tests:
  - each surface shows the toast with the right message
  - Undo calls `undoTask` with the id
  - no toast when there's no `undo_event_id`
  - a 409 shows the failure toast
  - delete is one click, and Undo reopens the modal

  Run `cd ui && npx vitest run && npx tsc --noEmit`. Commit with subject `feat(ui): undo toasts for task state, subtask checks and deletes`.

---

### Task 5: Docs, tracker, decisions

- [ ] `docs/web-ui-architecture.md`: complete "Undo for tasks", covering the token, CAS, cascades, deleting history, and purge.
- [ ] Spec tracker: Phase 6 `done`. Add a "Phase 6" section to the decisions log, covering at least:
  - delete is now one click with undo
  - purge after 1h
  - undo deletes history
  - only the newest change is undoable
  - the CLI `tasks undo`
- [ ] Verify: `make build && go test ./... && (cd ui && npx vitest run && npx tsc --noEmit)`.
- [ ] Commit with subject `docs: document task undo; mark Tasks Phase 6 done`.
