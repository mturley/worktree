# Tasks Phase 4 — Activity, Unread and Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Task events appear in the home, worktree and resource activity feeds (with a "Tasks" source filter). Events agents make are unread until marked read. They count toward the existing unread badges, are cleared by Mark all read (with its undo), and notify through the existing notifier.

**Architecture:** Task events stay in `task_events` and are never copied into `watcher_events`.
- **Feeds.** The two timeline handlers collect their watcher rows into a slice, fetch a page of task events for the same scope, convert them with Phase 3's `taskEventToTimeline`, then merge by `ts` and cut to the limit.
- **Unread state.** Each task has a read cursor in the existing `resource_read_cursor` table under `resource_type = 'task'`. `unread.Mark` and `unread.Restore` already work for any type except Slack.
- **Scope.** Which tasks belong to a feed reuses `tasks.List`, with `IncludeCompleted` and `IncludeArchived` both on.
- **Notifications.** The notifier gains a second scan over `task_events`.

**Tech Stack:** Go, React + Mantine, TanStack Query.

**Spec:** `docs/superpowers/specs/2026-10-21-tasks-design.md`, section "Task activity". The tracker is the spec's "Phases" table: set Phase 4 to "done" in the final commit. Unapproved decisions go in `docs/superpowers/specs/2026-10-21-tasks-autonomous-decisions.md` under "Phase 4".

## Global Constraints

- **Unread rule.** A task event is unread when `actor = 'agent'` AND `ts > the task's cursor`. A missing cursor row counts as `''`, so all of an agent's events count. The user's own events (`actor = 'user'`) are NEVER unread and NEVER notify. Events of soft-deleted tasks never appear and never count.
- **Feed membership.**
  - Home: every non-deleted task.
  - A worktree's feed: tasks in that worktree's scope, i.e. linked directly or implicitly, plus the archived fallback (`tasks.List` worktree scope with `IncludeCompleted` and `IncludeArchived`).
  - A resource-filtered feed (`resource_type` + `resource_id`): tasks linking that resource.
  - The home feed's `archived=false` view still shows every non-deleted task's events. `archived` only governs watcher events.
- **Converted rows.** A task event uses `taskEventToTimeline` (id `task:<event id>`, `source "tasks"`, `resource_type "task"`, `resource_id "<task id>"`), with `unread` set by the unread rule.
- **Filters.**
  - The source filter offers **Tasks** (type value `task`). With the source filter set and not including `task`, task events are excluded.
  - The event-type filter gains one category, **Task activity**, under Tasks. While any event-type category is selected, task events show only if that category is selected.
  - `q` search matches task events by the converted title and the task's title.
  - `unread_only` keeps only unread task events.
- **Pagination.** The `before` cursor (a ts) applies to both sources. The page is the newest `limit` of the merged set, and `next_cursor` is the last row's `ts`, unchanged.
- **Badges.**
  - `resourceDTO.unread_count` adds unread task events of open or done non-deleted tasks linking that resource. `has_unread` also turns true when that count is above 0.
  - `worktreeSummary.unread_count` and `has_unread` add the DISTINCT unread task events of tasks in the worktree's scope, NOT the sum over its resources. A task linked to two of the worktree's resources counts once.
  - The cmux unread mailbox (`worktreeHasUnread`) follows the same rule.
  - The task row shows the blue unread dot when the task has unread events. `taskDTO` gains `unread_count`.
- **Mark read.**
  - `POST /api/task-read {id, through_ts}` returns `{previous_ts, last_read_ts}`, using `unread.Mark("task", id, through_ts)`.
  - `POST /api/task-read/restore` is the CAS undo, using `unread.Restore`, and returns 409 if the cursor moved.
  - Mark all read, in each of its forms, also marks the unread tasks of its feed. Its undo restores those cursors too.
  - The task modal header gets a "Mark read" action, shown only when the task has unread events.
  - Opening the modal never marks anything read.
- **Notifications.**
  - Agent task events notify through the existing delivery: cmux, browser or the custom command, and the global "Enable notifications" switch.
  - A worktree is notified when it has "Notify on all", or "Notify on new events" on a resource that the task links, and the task is in that worktree's scope. A global task with no worktree notifies nobody.
  - There is one batch per (worktree, task). Title: the task's title. Subtitle: the worktree name. Body: the newest event's converted title, plus "(+N more)".
  - Task batches count toward the existing `notifyMaxPerPass` summary rule.
  - The notifier's own cursor over `task_events` uses the integer `id`, not `ts`, so there is no lookback window. It starts at `MAX(id)` and never replays history.
- **Event dots.** Task event types get a dot coloured `var(--task-accent)`.
- Commits: `git commit --signoff`, with the trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01HAFCNa6UnHnRzp1mmxFzto`. Add files by name. In `go test`, use `./cmd/...` and never `./cmd/`. Don't merge to main and don't push.

## Review Focus

1. **Paging across the two sources.** A task event older than the watcher page's last row must not be lost or duplicated on the next page. Test: `TestTimelineMergePaging` (Task 2).
2. **Double counting.** One unread agent event on a task linked to two of a worktree's resources counts as 1 for the worktree, and as 1 for each resource. Test: `TestWorktreeUnreadCountsTaskEventsOnce` (Task 3).
3. **Mark all read, then undo, with task cursors in the mix.** Undo puts every task cursor back. A 409 on one cursor still restores the others. Test (Task 6).
4. **Restarting the notifier.** It must not replay old agent events. Test: `TestTaskNotifyCursorStartsAtMax` (Task 4).
5. **The user's own task edits.** They never show as unread and never notify, even when made through the CLI without an agent environment. Test (Tasks 1 and 4).

---

### Task 1: Task-event queries and task unread summaries

**Files:**
- Create: `internal/tasks/feed.go`, `internal/tasks/feed_test.go`
- Modify: `internal/unread/unread.go` (`TaskSummaries`), `internal/unread/unread_test.go`

**Interfaces:**

```go
// internal/tasks
type FeedQuery struct {
	TaskIDs   []int64 // nil = every non-deleted task; empty non-nil = none
	Before    string  // exclusive ts cursor; "" = newest
	Limit     int
	AgentOnly bool    // only actor = 'agent'
	SinceTS   string  // inclusive lower bound; "" = none (for unread)
}
type FeedEvent struct{ Event; TaskTitle string }
func FeedEvents(conn *sql.DB, q FeedQuery) ([]FeedEvent, error) // newest first (ts DESC, id DESC); events of soft-deleted tasks excluded
func ScopeTaskIDs(conn *sql.DB, s Scope) ([]int64, error)       // List(...IncludeCompleted, IncludeArchived) ids; ScopeAll returns nil

// internal/unread
func TaskSummaries(conn *sql.DB) (map[int64]Summary, error)
// count + newest ts of agent events newer than the task's cursor (LEFT JOIN, missing = ''), non-deleted tasks only
```

- [ ] **Step 1: Write the failing tests:**
  - ordering and `before` paging
  - `TaskIDs` filtering (nil vs empty)
  - `AgentOnly`
  - deleted tasks excluded
  - `TaskSummaries` counts only agent events after the cursor, and counts all of them with no cursor row
  - `unread.Mark("task", "5", ts)` and `Restore` round-trip, with a 409 path
- [ ] **Step 2: Run** `go test ./internal/tasks ./internal/unread` and expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test ./internal/tasks ./internal/unread ./internal/db` and expect PASS.
- [ ] **Step 5: Commit** with subject `feat(tasks): task-event feed queries and per-task unread summaries`.

---

### Task 2: Task events in the timeline feeds

**Files:**
- Modify: `internal/webui/timeline.go`. Refactor `writeTimelineRows` into `collectTimelineRows`, which returns `[]TimelineEvent`, plus a writer. Add `mergeTaskEvents(...)`, used by `handleGlobalTimeline` and `handleWorktreeTimeline`.
- Modify: `internal/webui/task_timeline.go` (an `unread` flag on converted rows, and search matching)
- Test: `internal/webui/timeline_tasks_test.go`

**Interfaces:**
- Consumes `tasks.FeedEvents`, `tasks.ScopeTaskIDs`, `unread.TaskSummaries` or the cursor map, and `taskEventToTimeline`.
- Filter mapping follows Global Constraints. `resource_types` gets the new valid value `task`, which must be added to whatever whitelist `parseResourceTypes` validates against. `event_types` gets a new category value `task` (see `parseEventTypes`/`eventTypeFilter`), which matches every `task_*` type.
- Fetch `limit` task events with the same `before`. Merge by ts DESC; ties put the watcher row first. Cut to `limit`.

- [ ] **Step 1: Write the failing tests:**
  - home feed merge order
  - `TestTimelineMergePaging`: three task events interleaved with watcher events across two pages; no loss and no duplicates
  - worktree feed shows only its scope's tasks
  - a resource-filtered feed shows tasks linking that resource
  - a source filter without `task` excludes them
  - `event_types=task`
  - `unread_only`
  - a `q` match
  - a deleted task's events absent
  - the `unread` flag set only for agent events after the cursor
- [ ] **Step 2: Run** `go test ./internal/webui -run 'Timeline'` and expect FAIL.
- [ ] **Step 3: Implement.** Existing timeline tests must keep passing unchanged.
- [ ] **Step 4: Run** `go test ./internal/webui ./internal/tasks` and expect PASS.
- [ ] **Step 5: Commit** with subject `feat(webui): task events in the home, worktree and resource feeds`.

---

### Task 3: Unread badges and task read endpoints

**Files:**
- Modify: `internal/webui/unread.go` (`unreadIndex` gains task summaries; `fill` adds task counts to resources; a new `worktreeTaskUnread` helper)
- Modify: `internal/webui/worktrees.go`, `internal/webui/cmux_unread.go` (worktree totals with distinct task events)
- Modify: `internal/webui/tasks_api.go` (`taskDTO.UnreadCount`, `json:"unread_count"`; routes `POST /api/task-read` and `/api/task-read/restore`; `GET /api/task-unread?scope=all|worktree|resource&path=&type=&id=` returns `[{id, title, count, newest_ts}]` for tasks in scope with unread > 0)
- Modify: `internal/webui/server.go` (routes), `docs/web-ui-architecture.md` (API rows plus an "Unread" paragraph)
- Test: `internal/webui/tasks_unread_test.go`

- [ ] **Step 1: Write the failing tests:**
  - `TestWorktreeUnreadCountsTaskEventsOnce`
  - a resource count includes tasks linking it
  - `has_unread` flips on
  - task-read returns before and after values; restore gives a CAS 409
  - task-unread lists per scope
  - `taskDTO.unread_count`
  - the cmux mailbox turns on for a worktree with only task unread
- [ ] **Step 2: Run** them and expect FAIL. **Steps 3–4:** implement, then `go test ./internal/webui ./internal/unread` and expect PASS.
- [ ] **Step 5: Commit** with subject `feat(webui): task unread in badges, with task read and restore endpoints`.

---

### Task 4: Notifications for agent task events

**Files:**
- Modify: `internal/webui/notifier.go`, `internal/webui/notify_scan.go` (a task-event scan with an id cursor, and batching per Global Constraints)
- Test: `internal/webui/notify_tasks_test.go`

- [ ] **Step 1: Write the failing tests:**
  - `TestTaskNotifyCursorStartsAtMax`: existing events don't notify after a restart
  - an agent event on a task linked to a resource with "Notify on new events" notifies that worktree once
  - "Notify on all" notifies
  - user events never notify
  - a global task notifies nobody
  - a flood folds into the existing summary rule
- [ ] **Step 2: Run** them and expect FAIL. **Steps 3–4:** implement, then `go test ./internal/webui` and expect PASS.
- [ ] **Step 5: Commit** with subject `feat(webui): notify on agent task activity`.

---

### Task 5: Frontend — task events in feeds, filters, dots, unread dots

**Files:**
- Modify: `ui/src/lib/eventMeta.tsx` (every `task_*` type: accent colour, an icon such as `IconChecklist`, a label)
- Modify: `ui/src/components/EventDot.tsx` if it needs a non-Mantine colour for the accent token
- Modify: `ui/src/components/SourceFilter.tsx` and `ui/src/lib/sourceFilter.ts` (a "Tasks" source, `task`)
- Modify: `ui/src/lib/eventTypeFilter.ts` (a "Task activity" category, `task`)
- Modify: `ui/src/components/EventRow.tsx` and `TimelineFeed.tsx`. A row whose `resource_type === "task"` opens the task modal (`useTaskModal().open(Number(resource_id))`, wired through a prop, the same way `onMakeTask` was) rather than selecting a resource. "＋ task" stays hidden on it.
- Modify: `ui/src/components/tasks/TaskRow.tsx` (the blue `UnreadMarkerDot` when `unread_count > 0`), `ui/src/api/types.ts`
- Test: the corresponding `*.test.tsx`

- [ ] **Steps 1–4:** TDD (RED, then GREEN) for:
  - a task event's dot and label
  - Tasks in the source filter changing the timeline query
  - the Task activity category
  - clicking a task event opens the modal
  - the unread dot on TaskRow

  Run `cd ui && npx vitest run && npx tsc --noEmit`.
- [ ] **Step 5: Commit** with subject `feat(ui): task events in activity feeds with Tasks filters`.

---

### Task 6: Frontend — mark read (all forms) with undo, and the modal's Mark read

**Files:**
- Modify: `ui/src/api/client.ts` (`taskRead`, `taskReadRestore`, `taskUnread(scope)`)
- Modify: `ui/src/components/MarkAllReadButton.tsx`:
  - each form also fetches `taskUnread` for its scope and marks those tasks with their `newest_ts`
  - the preview modal lists them as rows next to the resources, with checkboxes, in the multi-resource form
  - the undo toast restores every task cursor as well
  - partial failures still offer undo for the writes that landed
- Modify: `ui/src/components/tasks/modal/TaskModalHeader.tsx`. Add "Mark read" when `unread_count > 0`, with its own undo toast through `showUndoToast`.
- Modify: `ui/src/hooks/useSSE.ts` if needed, so mark-read invalidations cover `["tasks"]`.
- Test: `MarkAllReadButton.test.tsx`, modal tests

- [ ] **Steps 1–4:** TDD (RED, then GREEN) for:
  - home Mark all read includes tasks
  - undo restores them, and a 409 on one still restores the rest
  - the single-resource form includes tasks linking that resource
  - the modal's Mark read, and its undo

  Run `cd ui && npx vitest run && npx tsc --noEmit`.
- [ ] **Step 5: Commit** with subject `feat(ui): mark task activity read, with undo`.

---

### Task 7: Docs, tracker, decisions

- [ ] Update `docs/web-ui-architecture.md`, covering the feeds merge, unread for tasks, notifications and the filters.
- [ ] In the spec, set Phase 4 to `done` with the plan path.
- [ ] Add a "Phase 4" section to the decisions log, listing every judgement call from the task reports and ledger rulings, each with a "To change" pointer.
- [ ] Verify: `make build && go test ./... && (cd ui && npx vitest run && npx tsc --noEmit)` all pass.
- [ ] Commit with subject `docs: document task activity, unread and notifications; mark Tasks Phase 4 done`.
