# Tasks Phase 5 — Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task can be blocked by other tasks, by resources (PR, Jira, Slack thread, link), or by free-text "other" blockers. Blockers on tasks and PR/Jira resources resolve on their own; Slack, link and "other" blockers are resolved by hand. A resource that blocks a task keeps being polled even when no worktree follows it. Blocked tasks show a red chip, resources show "⛔ blocks N tasks", and the user is notified when a blocker resolves on its own.

**Architecture:**
- `internal/tasks` gains a `task_blockers` table, blocker CRUD with cycle checks, `ReconcileHolds` (keeps one `task:<id>` subscription per resource blocker whose task is still open), and `ResolveBlockers` (compares task state, cached PR state and a Jira status-category lookup, then writes resolve or unresolve events with a new internal `system` actor).
- The poll loop calls `ResolveBlockers` and `ReconcileHolds` after every pass.
- Every query over `watcher_subscriptions` is audited, so that `task:` subscribers never count as "followed by a worktree".
- The notifier sends Unblocked notifications, which ignore the per-worktree and per-resource toggles.
- The UI adds a Blocked-by section in the sidebar slot reserved in Phase 3, a Blocks section on the Details tab, a blocked chip on rows, and a blocks badge on resource cards.

**Tech Stack:** Go, the watcher library v0.15.0 (`watcherdb.Subscribe/Unsubscribe`, `wjira.Client.Search`), and React + Mantine.

**Spec:** `docs/superpowers/specs/2026-10-21-tasks-design.md`, section "Blockers". The tracker is the spec's "Phases" table: set Phase 5 to "done" in the final commit. Record decisions in `docs/superpowers/specs/2026-10-21-tasks-autonomous-decisions.md` under "Phase 5".

## Global Constraints

- **Blocker kinds.**
  - `task`: resolved when the blocking task is `done`. A deleted blocking task also resolves it, with the reason "deleted".
  - `resource`:
    - A PR resolves when it is merged or closed, read from the PR's cached `watcher_resource_state`.
    - A Jira issue resolves when its status category is `done`. The category comes from `wjira.Client.Search("key in (…)")` (`IssueSummary.StatusCategory`), which needs no watcher release. The lookup runs only while the Jira watcher is enabled and Jira is configured; otherwise the blocker keeps its last state.
    - Slack threads and links are resolved by hand.
  - `other`: free text, resolved by hand.
- **Unresolving.**
  - A blocker that resolved on its own unresolves on its own when its condition stops holding: the PR is reopened, the Jira issue leaves Done, or the blocking task leaves done.
  - A blocker the user resolved by hand stays resolved until the user unresolves it.
- **Blocked.** A task is blocked while any of its blockers is unresolved. `taskDTO` gains `blocked` (bool) and `blocker_count` (unresolved count). Resolved blockers stay listed, dimmed with a check, and are never shown in red.
- **Cycles.** Adding a task blocker that would create a cycle among unresolved task blockers (including a task blocking itself) is rejected with `ErrInvalid` ("would create a blocking cycle").
- **Which resources can block.** The resource picker offers resources followed by the task's worktrees, direct or implicit. For a global task it offers every followed resource. The server accepts any resource type and id, the same rule as links.
- **Holds.**
  - Each resource blocker of a task that is neither `done` nor deleted holds one active `watcher_subscriptions` row, with subscriber `task:<task id>`, for that resource.
  - The hold is released when the blocker is removed, or when the task is completed or deleted. It is re-acquired when the task is reopened. It is NOT released when the blocker resolves.
  - `ReconcileHolds(conn)` makes the hold rows match exactly what should be held (subscribe the missing ones, unsubscribe the extra ones). It is idempotent. Every blocker write and every state change calls it after commit, and so does the poll loop after every pass.
  - A watcher subscribe/unsubscribe can't run inside a tasks `inTx`, because the watcher library opens its own transactions.
- **Subscriber audit.** No `task:` subscriber may make a resource appear followed. Every query that joins or iterates `watcher_subscriptions` must restrict to `worktree:` subscribers wherever it means "followed by a worktree". That covers:
  - the home timeline's `watchedJoin` and the worktree timeline
  - all-resources, worktree resources, archived detection and search
  - unread
  - the notifier and the cmux mailbox
  - `migrate.go`'s cursor backfill, which can keep all subscribers
  - `resources.Load` and the CLI listings

  `watcherdb.ActiveResources` deliberately keeps counting holds, because that is what keeps the resource polled.
- **Events.** New task event types:
  - `task_blocker_added`
  - `task_blocker_removed`
  - `task_blocker_resolved`, with payload `{blocker_id, kind, label, auto: bool, reason}`
  - `task_blocker_unresolved`

  Automatic resolve and unresolve events use a new internal actor `system`. It is accepted only by internal functions; the CLI and web always write as user or agent. Phase 4's unread rule becomes **actor ≠ 'user'**, so `system` events are unread as well.
- **Notifications.** A blocker that resolves on its own sends an "Unblocked" notification.
  - It obeys only the global "Enable notifications" switch and ignores the per-worktree and per-resource toggles.
  - Title: the task title. Body: "Unblocked: <label> <reason>", e.g. "Unblocked: #4498 merged".
  - Target: the worktree of the task's first Focus link if that is a worktree or a resource some worktree follows; otherwise the first worktree in the task's scope; otherwise untargeted.
  - Automatic unresolves don't notify.
- **Displays.**
  - Row: one red "⛔ blocked" chip. Hovering it lists the unresolved blockers.
  - Resource cards: "⛔ blocks N tasks", counting open tasks that the resource currently blocks, unresolved only.
  - Modal sidebar, "Blocked by": each blocker shows its kind icon, label, status (e.g. "merged", "In Progress", "done") and a resolved check. "other", Slack and link blockers have a manual resolve checkbox. Each blocker has a remove (✕). "+ Add" chooses Task, Resource or Other.
  - Details tab, "Blocks": the tasks this one blocks, each clickable via `open(id)`, which replaces the history entry.
- Commits: `git commit --signoff`, with the trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01HAFCNa6UnHnRzp1mmxFzto`. Add files by name. In `go test`, use `./cmd/...`, never `./cmd/`. Don't merge to main, don't push, and don't touch `~/git/watcher`.

## Review Focus

1. **A PR blocker on a resource no worktree follows.** It must still get polled through the hold, and the PR must not appear in any worktree, in the Resources tab, or as "followed". Test: `TestHoldKeepsResourcePolledButUnfollowed` (Task 2).
2. **Completing a task with a resource blocker.** The hold is released, and reopening the task re-acquires it. Test: `TestHoldLifecycle` (Task 2).
3. **A PR merged and then reopened.** The blocker auto-resolves (with a notification) and then auto-unresolves (with no notification). Test (Task 3 and Task 5).
4. **The Jira watcher is disabled.** Jira blockers keep their last state, and Jira is never contacted. Test (Task 3).
5. **A blocking cycle attempted through the UI.** It is rejected with a readable message. Test (Tasks 1 and 6).

---

### Task 1: Blockers in `internal/tasks`

**Files:**
- Modify: `internal/db/migrate.go` (table `task_blockers`)
- Create: `internal/tasks/blockers.go`, `internal/tasks/blockers_test.go`
- Modify: `internal/tasks/tasks.go` (`ActorSystem` "system", accepted only by internal callers; `Task.Blocked` and `Task.BlockerCount` filled by the list compute)
- Modify: `internal/tasks/events.go` (the four constants)
- Modify: the single unread-actors source of truth that Phase 4's final fixes introduced in `internal/tasks`: add `system` to it (`CountsAsUnread`, the SQL helper, and `internal/unread`'s mirrored list along with its agreement test). Nothing else should need to change for `system` to be unread. Verify that the feed's dots, the badges, `unread_only` and the notifier all pick it up.

```sql
CREATE TABLE IF NOT EXISTS task_blockers (
	id               INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id          INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	kind             TEXT NOT NULL CHECK (kind IN ('task','resource','other')),
	blocking_task_id INTEGER,
	resource_type    TEXT NOT NULL DEFAULT '',
	resource_id      TEXT NOT NULL DEFAULT '',
	text             TEXT NOT NULL DEFAULT '',
	resolved_at      TEXT,
	resolved_auto    INTEGER NOT NULL DEFAULT 0,
	resolved_reason  TEXT NOT NULL DEFAULT '',
	created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_blockers_task ON task_blockers (task_id);
CREATE INDEX IF NOT EXISTS task_blockers_blocking ON task_blockers (blocking_task_id);
CREATE INDEX IF NOT EXISTS task_blockers_resource ON task_blockers (resource_type, resource_id);
```

**Interfaces:**

```go
type BlockerTarget struct{ Kind string; BlockingTaskID int64; ResourceType, ResourceID, Text string } // renamed from TaskID in review (shadowed Blocker.TaskID)
type Blocker struct{ ID, TaskID int64; BlockerTarget; ResolvedAt string; ResolvedAuto bool; ResolvedReason string; CreatedAt string }
func AddBlocker(conn *sql.DB, a Actor, taskID int64, t BlockerTarget) (Blocker, error) // validates; rejects duplicates (same target) as no-op returning existing; cycle check for kind task
func RemoveBlocker(conn *sql.DB, a Actor, blockerID int64) error
func SetBlockerResolved(conn *sql.DB, a Actor, blockerID int64, resolved bool) error // manual: only for kind other, or resource of type slack|link; ErrInvalid otherwise
func Blockers(conn *sql.DB, taskID int64) ([]Blocker, error)           // unresolved first, then by created_at
func Blocking(conn *sql.DB, taskID int64) ([]int64, error)             // ids of non-deleted tasks this task blocks (unresolved or resolved)
func ResourceBlockCounts(conn *sql.DB) (map[string]int, error)         // "type:id" -> open non-deleted tasks with an UNRESOLVED blocker on it
```

Writes use `inTx`, so the version bumps, and record events. Blocker writes also bump the task's `updated_at`. Never call a public tasks function inside an `inTx` body.

- [ ] **Steps 1–5 (TDD):**
  - Tests:
    - add, list and remove for each kind
    - a duplicate add is a no-op
    - a self-block and a two- and three-task cycle are rejected
    - manual resolve is allowed and refused per the rules
    - `Blocked` and `BlockerCount` on `Get`/`List`
    - `ResourceBlockCounts`
    - `TaskSummaries` counts `system` events
    - a deleted task's blockers are excluded
  - Run `go test ./internal/tasks ./internal/unread ./internal/webui ./cmd/...`.
  - Commit: `feat(tasks): task blockers with cycle checks and a system actor`

---

### Task 2: Holds and the subscriber audit

**Files:**
- Create: `internal/tasks/holds.go`, `internal/tasks/holds_test.go` (`ReconcileHolds(conn) error`, `HoldSubscriber(taskID) string` → `"task:<id>"`)
- Modify: every `watcher_subscriptions` query that means "followed by a worktree" (see Global Constraints). Grep `internal/` and `cmd/` for `watcher_subscriptions` and `ActiveSubscriptions(` / `SubscribersOf(` / `AllSubscriptions(`.
- Modify: `internal/tasks` write paths (`AddBlocker`, `RemoveBlocker`, `SetState`, `Delete`, `Create` with blockers if any) to call `ReconcileHolds` after commit. Log, don't fail, if the reconcile errors, since the poll loop retries.
- Test: `internal/webui/holds_audit_test.go`

- [ ] **Steps 1–5 (TDD):**
  - Tests:
    - `TestHoldLifecycle`: add a PR blocker to an open task, and the hold exists. Complete the task, and the hold is gone. Reopen it, and the hold is back. Remove the blocker, and the hold is gone.
    - `TestHoldKeepsResourcePolledButUnfollowed`: with only a hold, `watcherdb.ActiveResources("pr")` includes the PR. Meanwhile:
      - `/api/all-resources`, `/api/worktree-resources`, `/api/worktrees` counts, and the home timeline (archived=false) don't show it as followed
      - `tasks.List` marks a link to it archived
      - unread and notifications ignore it
  - Run `go test ./internal/... ./cmd/...`.
  - Commit: `feat(tasks): blocker subscription holds; keep task: subscribers out of "followed"`

---

### Task 3: The resolution engine, wired into the poll loop

**Files:**
- Create: `internal/tasks/resolve.go`, `internal/tasks/resolve_test.go`

```go
type ResourceStatus struct{ Done bool; Label string } // Label: "merged", "closed", "Done", "In Progress"...
type StatusLookup func(resourceType, resourceID string) (ResourceStatus, bool) // ok=false: unknown, keep last state
type Resolution struct{ TaskID, BlockerID int64; Resolved bool; Label, Reason string } // what changed this pass
func ResolveBlockers(conn *sql.DB, lookup StatusLookup) ([]Resolution, error)
```

`ResolveBlockers` evaluates every unresolved blocker, and every blocker resolved automatically (to catch reopens), on non-deleted, not-done tasks. A manually resolved blocker is never changed. It writes resolve and unresolve rows, with `system` events, in one `inTx`, and returns the changes.

- Create: `internal/webui/blocker_status.go`. It builds the `StatusLookup`:
  - PRs read the cached state (`watcher_resource_state`, using whatever key the PR state JSON uses for merged/closed; check `buildPRStateJSON` in watcher v0.15.0).
  - Jira runs one `wjira.Client.Search` per pass for every Jira key under an unresolved or auto-resolved blocker. This happens only if `s.WatcherEnabled(config.ServiceJira)` and Jira is configured. Results are cached in memory with the pass. On error, return ok=false.
  - Slack and link blockers return ok=false.
- Modify: `internal/webui/poller.go`. After `pollAll`, call `ResolveBlockers` then `tasks.ReconcileHolds`, and hand the `[]Resolution` to the notifier (Task 5). Also call it after any task state write from the web API, so a completed task unblocks others at once. A helper `s.afterTaskWrite()` will do.
- Tests:
  - A task blocker resolves when its blocker is done and unresolves when that task is reopened.
  - A PR merged gives resolved (the label is "merged"); reopened gives unresolved.
  - A manual resolve is never touched.
  - With the Jira watcher disabled, the lookup returns ok=false and no Jira client is constructed (use a seam).
  - A Jira status category of `done` resolves.
- Commit: `feat(tasks): resolve blockers from task state, PR state and Jira status`

---

### Task 4: Web API for blockers and blocking

**Files:**
- Modify: `internal/webui/tasks_api.go`
  - `taskDTO` gains `blocked` and `blocker_count`.
  - `resourceDTO` gains `blocks_count`. `/api/worktree-resources` and `/api/all-resources` fill it from `ResourceBlockCounts`, computed once per request.
- Modify: `internal/webui/tasks_detail_api.go`
  - `taskDetailDTO` gains `blockers`: `[{id, kind, label, url?, status_label, resolved, resolved_auto, resolved_reason, manual_resolvable, task_id?, resource_type?, resource_id?, text?}]`.
  - It also gains `blocks`: `[{id, ref, title, state}]`.
  - Labels: a task is "T<id> <title>"; a resource uses its custom name, then its title, then its short ref; other uses its text.
  - New routes: `POST /api/tasks/blockers/add {id, kind, task_id?, url?|type+rid?, text?}`, `POST /api/tasks/blockers/remove {blocker_id}` and `POST /api/tasks/blockers/resolve {blocker_id, resolved}`. Each returns the fresh detail.
- Modify: `internal/webui/task_timeline.go` (titles for the four new event types), `docs/web-ui-architecture.md`
- Tests: the routes, the DTO fields, the 400 message for a cycle, and `blocks_count`.
- Commit: `feat(webui): blocker endpoints and blocked/blocks fields`

---

### Task 5: Unblocked notifications

**Files:**
- Modify: `internal/webui/notifier.go` and `notify_scan.go`. Add a path that takes `[]Resolution` (resolved ones only) from the poll and the web writes, then builds one notification per resolution, targeted per Global Constraints, ignoring the toggles and honouring the global switch.
- Modify: the Phase 4 task-event scan, so it SKIPS `system` blocker events. Unblocked events notify through this dedicated path, and must not notify twice.
- Tests:
  - A resolution notifies even with every toggle off.
  - The global switch off means no notification.
  - The targeting order.
  - No double notification.
  - An unresolve doesn't notify.
- Commit: `feat(webui): notify when a blocker resolves on its own`

---

### Task 6: UI — Blocked by, Blocks, chips, badges

**Files:**
- Modify: `ui/src/api/types.ts` and `client.ts` (the fields and routes above), `ui/src/hooks/useTaskDetail.ts` (mutations `addBlocker`, `removeBlocker`, `resolveBlocker`)
- Create: `ui/src/components/tasks/modal/BlockersSection.tsx` (rendered in the sidebar's reserved Blocked-by slot) and `BlockerPicker.tsx`:
  - The Task kind searches open tasks with `useTasks` scope all, excluding itself.
  - The Resource kind reuses LinkPicker's suggestion source (the task's worktrees' resources, or all resources for a global task, plus a pasted URL).
  - The Other kind is a text input.
- Create: `ui/src/components/tasks/modal/BlocksSection.tsx` (Details tab, after Linked events; rows call `open(id)`)
- Modify: `ui/src/components/tasks/TaskRow.tsx` (a red "⛔ blocked" chip whose tooltip lists the unresolved blocker labels, read from a detail-free field: add `blocker_labels: string[]` to `taskDTO` in Task 4 for this)
- Modify: `ui/src/components/ResourceCard.tsx` and `AllResourceRow.tsx` ("⛔ blocks N" when `blocks_count > 0`)
- Modify: `ui/src/lib/eventMeta.tsx` (the four new types)
- Tests:
  - add a blocker of each kind
  - a cycle error shown inline
  - manual resolve shown only where allowed
  - remove
  - the Blocks section opens the task
  - the row chip and its tooltip
  - the card badge
- Commit: `feat(ui): task blockers — Blocked by, Blocks, blocked chips and blocks badges`

---

### Task 7: Docs, tracker, decisions

- [ ] `docs/web-ui-architecture.md`: a "Blockers" section covering kinds, resolution, holds plus the subscriber audit rule, notifications, and the `system` actor.
- [ ] Update the `.claude/CLAUDE.md` `resources` package entry (and wherever "every subscriber is a worktree" is implied) to state the `task:` hold subscribers.
- [ ] Spec tracker: Phase 5 `done`. Decisions log: a "Phase 5" section, from the reports and rulings.
- [ ] Verify: `make build && go test ./... && (cd ui && npx vitest run && npx tsc --noEmit)`.
- [ ] Commit: `docs: document task blockers; mark Tasks Phase 5 done`
