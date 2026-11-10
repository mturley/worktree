# Task Work Log, Task Subfilters & Task Unread Surfaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Mike log work on a task (editable entries), filter task activity by kind, page the task Activity tab, open event details from it (stacked), and see and clear a task's combined unread (own + linked resources) from the task modal and task rows.

**Architecture:** Work logs are a new `task_events` type (`task_work_logged`) written by three new `tasks` functions. They are the only task events that can be edited or deleted. The webui adds work-log routes, type-level task filtering in `event_types`, a paged `/api/tasks/activity`, and `combined_unread_count` on task DTOs, computed from one `unreadIndex` per request. The UI adds a Log work popover, work-log editing in `EventDetailsModal`, stacked details from the Activity tab, a task-modal "open on Activity with this event" entry point used by every feed, Tasks subfilters, the unread badge and row highlight, and a task-scoped `MarkAllReadButton`.

**Tech Stack:** Go (SQLite, `net/http`), React + Mantine 7 + TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-task-work-log-and-unread-design.md` (read it alongside this plan; section numbers below are the spec's).

## Global Constraints

- Work into worktree `~/.worktrees/worktree/task-log-work`, branch `task-log-work`.
- Commits: `git commit --signoff`, add files by name (never `git add -A`/`.`), end messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Go tests: new top-level tests in `internal/webui` call `t.Parallel()` first unless they use `t.Setenv`/globals; never build git fixtures from scratch (use `testgit`). After touching webui tests run `go test -race ./internal/webui/`.
- No new CLI writes. No watcher library change. No schema change (payload is JSON), so `schemaVersion` is untouched.
- Only `task_work_logged` events may be edited or deleted. All other task events stay immutable.
- Unread rule unchanged: only agent/system task events are unread (`tasks.CountsAsUnread`).
- A linked resource that no live worktree follows contributes **0** to `combined_unread_count`. "Followed" means a `watcher_subscriptions` row with `subscriber LIKE 'worktree:%' AND deleted_at IS NULL` (the rule `unread.IsFollowed` uses).
- Event title copy: `Worked on "<task title>"` (built with the existing `quote()` helper in `task_timeline.go`). Type label: `work logged`. Edited marker: `(edited)`.
- Subfilter categories, exactly:
  - `progress` "Progress": `task_work_logged`, `task_state_changed`, `subtask_checked`, `subtask_unchecked`
  - `blockers` "Blockers": `task_blocker_resolved`, `task_blocker_unresolved`
  - `lifecycle` "Created / deleted": `task_created`, `task_deleted`
- Any change to a documented behaviour updates the matching section of `docs/web-ui-architecture.md` in the same task.
- Lint: never disable a lint rule. UI checks: `cd ui && npx tsc -b && npm test -- <pattern>`.

## Review Focus

1. **Stacked Esc:** with event details open over the task modal (and over the Mark all read modal over the task modal), Esc closes only the topmost modal. Pinned by a test in Task 9.
2. **Edit/delete of a non-work-log event:** the API must refuse to edit or delete any other task event type (400), even with a valid event id. Pinned in Tasks 1 and 2.
3. **Same-second page boundary in task activity:** events sharing the boundary ts must neither repeat nor be skipped across pages. Pinned in Task 4.
4. **Unfollowed linked resource:** a task linking a resource with a cursor but no `worktree:` subscriber shows `combined_unread_count` without that resource's unread. Pinned in Task 5.
5. **Task deleted between render and click:** clicking a feed's task event for a task that no longer loads must still show the event details, without Edit, rather than an empty or broken modal. Pinned in Task 9.

---

### Task 1: Work log writes and type-filtered feed (`internal/tasks`)

**Files:**
- Modify: `internal/tasks/events.go` (constant, note on categories)
- Create: `internal/tasks/worklog.go`
- Modify: `internal/tasks/feed.go` (`FeedQuery.Types`)
- Test: `internal/tasks/worklog_test.go`, `internal/tasks/feed_test.go`

**Interfaces:**
- Produces:
  - `const EventTaskWorkLogged = "task_work_logged"` // payload `{"text","edited_at"?}`
  - `var ErrNotWorkLog = fmt.Errorf("%w: not a work log entry", ErrInvalid)`
  - `const MaxWorkLogText = 4000` (runes, after trimming)
  - `func LogWork(conn *sql.DB, a Actor, taskID int64, text string) (Event, error)`
  - `func EditWorkLog(conn *sql.DB, a Actor, eventID int64, text string) (Event, error)`
  - `func DeleteWorkLog(conn *sql.DB, a Actor, eventID int64) (taskID int64, err error)`
  - `func WorkLogTaskID(conn *sql.DB, eventID int64) (int64, error)` — `ErrNotFound` if there is no such event, `ErrNotWorkLog` if it isn't one
  - `type WorkLogPayload struct { Text string `json:"text"`; EditedAt string `json:"edited_at,omitempty"` }`
  - `FeedQuery.Types []string` — nil/empty means every type; otherwise SQL `e.type IN (...)`, applied before `LIMIT`.

- [ ] **Step 1: Write failing tests** in `worklog_test.go`:
  - `TestLogWorkRecordsEvent`: `LogWork(conn, user, tk.ID, "  did X\nand Y ")` returns an Event with Type `task_work_logged`, Actor `user`, payload text `"did X\nand Y"` (trimmed, newline kept). `Events(conn, tk.ID)[0]` is the same event. The task's `UpdatedAt` advanced.
  - `TestLogWorkValidation`: empty or whitespace-only text → `errors.Is(err, ErrInvalid)`; 4001 runes → `ErrInvalid`; exactly 4000 → ok; missing task → `ErrNotFound`; deleted task → `ErrNotFound`.
  - `TestEditWorkLog`: edit changes the payload text, sets `edited_at` (RFC3339), and leaves the event's `TS` and `ID` unchanged. Editing to identical text writes nothing (`Version` unchanged, `edited_at` absent).
  - `TestEditDeleteRefuseOtherTypes`: for the `task_created` event's id, both `EditWorkLog` and `DeleteWorkLog` return `ErrNotWorkLog`, and the row is untouched.
  - `TestDeleteWorkLog`: the row is gone from `Events`; it returns the task id; deleting again → `ErrNotFound`.
  - `TestWorkLogAgentActorAllowed`: an `agent` actor is accepted by `LogWork` (the package doesn't restrict this; the web layer passes the user).
- [ ] **Step 2:** In `feed_test.go` add `TestFeedEventsTypes`: with a created task, one work log and one state change, `FeedEvents(conn, FeedQuery{Types: []string{"task_work_logged"}})` returns only the work log, and `Types: nil` returns all three.
- [ ] **Step 3: Run** `go test ./internal/tasks/ -run 'WorkLog|LogWork|FeedEventsTypes'`. Expected: FAIL (undefined).
- [ ] **Step 4: Implement.** Use `inTx`, `validActor` (user/agent only), `load` (refuses deleted tasks), `record`, and `touch`. Edit and delete check the row's `type` inside the tx and touch its task. Add a comment above the event constants: every new task event type must be placed in a Tasks subfilter category (`ui/src/lib/eventTypeFilter.ts`).
- [ ] **Step 5: Run** `go test ./internal/tasks/`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(tasks): work log events (log, edit, delete) and type-filtered feed`.

### Task 2: Work log API and rendering (`internal/webui`, CLI)

**Files:**
- Modify: `internal/webui/server.go` (routes), `internal/webui/tasks_detail_api.go` (handlers), `internal/webui/task_timeline.go` (title, label, edited), `internal/webui/timeline.go` (`TimelineEvent.EditedAt`)
- Check/Modify: `cmd/tasks.go` (`tasks show` history) and `cmd/activity*.go`, so the new type renders through the shared titles
- Test: `internal/webui/tasks_worklog_api_test.go`, `internal/webui/timeline_tasks_test.go`
- Docs: `docs/web-ui-architecture.md` "Task detail API"

**Interfaces:**
- Consumes: Task 1's `LogWork`, `EditWorkLog`, `DeleteWorkLog`, `WorkLogTaskID`, `WorkLogPayload`, `ErrNotWorkLog`.
- Produces (all use `webActor`, call `s.afterTaskWrite()`, and answer with `s.writeTaskDetail(w, taskID)`, like the subtask routes):
  - `POST /api/tasks/worklog/add` body `{id, text}`
  - `POST /api/tasks/worklog/edit` body `{event_id, text}`
  - `POST /api/tasks/worklog/delete` body `{event_id}`
  - `TimelineEvent.EditedAt string `json:"edited_at,omitempty"`` — set from the payload for work logs
  - Work log `TimelineEvent.Body` = payload text; Title = `Worked on "<title>"`; TypeLabel = `work logged`.
- `writeTaskError` maps `ErrNotWorkLog` (it wraps `ErrInvalid`) to 400. Verify it.

- [ ] **Step 1: Write failing tests** (`t.Parallel()`, `tasksServer`, `serveTasks`):
  - `TestWorkLogAPIAddEditDelete`: add → 200 with detail; `getActivity(t, s, id, "filter=task")` has a row with type `task_work_logged`, title `Worked on "T title"`, body = text, and no `edited_at`. Edit → the row's body changes and `edited_at` is non-empty. Delete → the row is gone.
  - `TestWorkLogAPIRefusesOtherEvents`: edit or delete with the `task_created` event's id → 400; unknown id → 404; empty text → 400.
  - In `timeline_tasks_test.go`, `TestGlobalTimelineShowsWorkLog`: the global timeline includes the work log with the same title and body.
- [ ] **Step 2: Run** `go test ./internal/webui/ -run 'WorkLog'`. Expected: FAIL.
- [ ] **Step 3: Implement** the handlers, routes, the `taskEventTitles` and `taskEventLabels` entries, and `EditedAt`/`Body` in `taskEventToTimeline`. Check `worktree tasks show <id>` and `worktree activity` print the title. If they format task events themselves rather than through `taskEventToTimeline`, route them through it.
- [ ] **Step 4: Run** `go test ./internal/webui/ ./cmd/` and `go test -race ./internal/webui/ -run WorkLog`. Expected: PASS.
- [ ] **Step 5:** Update the architecture doc (routes, editable-only-work-log rule). **Commit** `feat(webui): work log routes and timeline rendering`.

### Task 3: Type-level task filtering in `event_types`

**Files:**
- Modify: `internal/webui/timeline.go` (`eventTypeFilter.includesTasks`, new `taskTypes()`, `taskFeedQuery.types`, `mergeTaskEvents` passing `tasks.FeedQuery.Types`)
- Test: `internal/webui/timeline_tasks_test.go`
- Docs: `docs/web-ui-architecture.md` (Activity subfilters)

**Interfaces:**
- Consumes: `tasks.FeedQuery.Types` (Task 1).
- Produces:
  - `func (f eventTypeFilter) taskTypes() []string` — nil when the filter is empty or contains `task` (meaning all task events); otherwise the exact values with prefix `task_` or `subtask_`.
  - `includesTasks()` is true when the filter is empty, contains `task`, or `taskTypes()` is non-empty.

- [ ] **Step 1: Write failing tests:** `TestTimelineTaskEventTypes` (global and worktree timelines), with a task that has a created event, a work log, a checked subtask and a state change:
  - `event_types=task_work_logged,task_state_changed,subtask_checked,subtask_unchecked` → exactly the work log, the subtask check and the state change;
  - `event_types=task_created,task_deleted` → only the creation;
  - `event_types=task` → all four;
  - `event_types=pr_comment` → no task events;
  - `resource_types=task&event_types=task_work_logged&unread_only=1` with the log by `user` → empty (the unread rule holds).
- [ ] **Step 2: Run** `go test ./internal/webui/ -run TimelineTaskEventTypes`. Expected: FAIL.
- [ ] **Step 3: Implement.** Thread `taskTypes()` into every `taskFeedQuery` built in `timeline.go`, and into the `FeedQuery` that `mergeTaskEvents` builds.
- [ ] **Step 4: Run** `go test ./internal/webui/` and `-race`. Expected: PASS.
- [ ] **Step 5:** Docs. **Commit** `feat(webui): filter task events by type in event_types`.

### Task 4: Paged task activity (server + client)

**Files:**
- Modify: `internal/webui/tasks_detail_api.go` (`handleTaskActivity`)
- Modify: `ui/src/api/client.ts` (`taskActivity`), `ui/src/hooks/useTaskDetail.ts` (`useTaskActivity`), `ui/src/components/tasks/modal/ActivityTab.tsx` (load more)
- Test: `internal/webui/tasks_detail_api_test.go` (update `getActivity` for the new shape), `ui/src/components/tasks/modal/ActivityTab.test.tsx`
- Docs: "Task detail API"

**Interfaces:**
- Produces:
  - `GET /api/tasks/activity?id=&filter=&type=&rid=&before=&limit=` → `TimelineResponse` `{events, next_cursor}`. `limit` defaults to `taskActivityLimit` (200), clamps to [1, 200]. `before` is an exclusive ts. `next_cursor` = the last row's ts (same convention as the timelines: a short page means the end).
  - Each source is read **before the cursor**: own task events through `tasks.FeedEvents(FeedQuery{TaskIDs: [id], Before, Limit})`, resource events through a before-aware read (use `watcherdb` if it has one; otherwise the timeline's resource query), event links filtered in Go. After merging, the page is cut at `limit`, then **overfilled** with every remaining row whose ts equals the last kept row's ts (fetch each source's boundary cluster, as `mergeTaskEvents` does via `AtTS`/`watcherTies`).
  - Client: `api.taskActivity(id, filter, resource?, before?) => Promise<TimelineResponse>`. `useTaskActivity(id, q)` returns `TimelineResult` (`ui/src/hooks/useTimeline.ts`) via `useInfiniteQuery`, keeping the key prefix `["tasks", "activity", id, …]`. Export `nextCursor`/`flatten` from `useTimeline.ts`, or a page-size-aware variant, rather than copying them.

- [ ] **Step 1: Write failing Go tests:**
  - `TestTaskActivityPaging`: a task with 5 own events at distinct seconds; `limit=2` returns 2 events, `before=<next_cursor>` returns the next 2, then 1. The union equals the unpaged list, with no duplicates.
  - `TestTaskActivityPagingSameSecondCluster`: 3 events sharing one ts plus 1 older; `limit=2` → the first page holds all 3 tied rows (overfill), and the next page holds only the older one.
  - Update existing callers of `getActivity` to decode `.events`.
- [ ] **Step 2: Run** `go test ./internal/webui/ -run TaskActivity`. Expected: FAIL.
- [ ] **Step 3: Implement the server.**
- [ ] **Step 4: Write a failing UI test** in `ActivityTab.test.tsx`: when the first page is full (mock 200 events with `next_cursor`), the tab shows the feeds' load-more control, and activating it requests `before=<cursor>` and appends the rows.
- [ ] **Step 5: Implement the client.** `ActivityTab` renders the same load-more control `TimelineFeed` uses (reuse it; don't make a second one).
- [ ] **Step 6: Run** `go test ./internal/webui/ && go test -race ./internal/webui/ -run TaskActivity` and `cd ui && npx tsc -b && npm test -- ActivityTab useTaskDetail`. Expected: PASS.
- [ ] **Step 7:** Docs. **Commit** `feat: page the task activity feed`.

### Task 5: Combined unread count, task linked resources, single-task unread scope

**Files:**
- Modify: `internal/webui/tasks_api.go` (`taskDTO.CombinedUnreadCount`, `handleListTasks`, `newTaskDTOWithUnread`, `parseTaskScope` for `scope=task`, `handleTaskUnread`)
- Create: `internal/webui/task_linked_unread.go`
- Modify: `internal/webui/tasks_detail_api.go` (detail DTO gains linked resources)
- Test: `internal/webui/tasks_unread_test.go`
- Docs: "Unread", "Task detail API"

**Interfaces:**
- Produces:
  - `taskDTO.CombinedUnreadCount int `json:"combined_unread_count"``: own `UnreadCount` plus, for each distinct **followed** resource link, that resource's **own** unread (`fillOwn` semantics, not `fill`, so other tasks' events are not counted).
  - `func (s *Server) taskLinkedUnread(ix *unreadIndex, followed map[string]bool, memo map[string]resourceDTO, t tasks.Task) (sum int, dtos []resourceDTO)`: builds an enriched DTO per resource link (`enrichResourceDTO`, then `ix.fill`), memoized by `type:id` within one request. Unfollowed links are skipped from `sum` but still returned in `dtos` (with zero counts), so the modal can list them.
  - `func (s *Server) followedResources() (map[string]bool, error)`: one query over `watcher_subscriptions` (`subscriber LIKE 'worktree:%' AND deleted_at IS NULL`), keyed `type:id`.
  - `/api/tasks` and the single-task endpoints build **one** `newUnreadIndex()` and one `followedResources()` per request.
  - `taskDetailDTO.LinkedResources []resourceDTO `json:"linked_resources"`` (never null): the `dtos` above, for `MarkAllReadButton`.
  - `scope=task&id=<n>` accepted by `parseTaskScope` (new `tasks.Scope` handling: either add `tasks.ScopeTask` with `TaskID`, or special-case it in the webui; `ScopeTaskIDs` returns `[id]`). `GET /api/task-unread?scope=task&id=` returns that task only when it has unread events.
  - TS (in Task 10/11): `Task.combined_unread_count?: number`, `TaskDetail.linked_resources: ResourceDTO[]`, and `TaskScope` gains `{ kind: "task"; id: number }`.

- [ ] **Step 1: Write failing tests** (`tasks_unread_test.go`, using `testgit.Worktree` where a followed resource is needed):
  - `TestCombinedUnreadCountsLinkedResources`: a PR followed by the worktree has 2 unread events, and a task links it and has 1 unread agent event → `combined_unread_count == 3`, `unread_count == 1`.
  - `TestCombinedUnreadSkipsUnfollowed`: a resource with a read cursor and unread events but only a `task:<id>` subscriber → it adds 0.
  - `TestCombinedUnreadNoDoubleCountAcrossTasks`: two tasks link the same PR, and only task A has its own unread → B's combined count = the PR's unread only (it doesn't include A's events).
  - `TestTaskUnreadScopeTask`: `scope=task&id=A` → `[A]` when A has unread events, `[]` otherwise; a missing id → 400.
  - `TestTaskDetailLinkedResources`: the detail has `linked_resources` with the PR's `unread_count` and `unread_through_ts`.
- [ ] **Step 2: Run** `go test ./internal/webui/ -run 'CombinedUnread|TaskUnreadScopeTask|TaskDetailLinkedResources'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test ./internal/webui/ ./internal/tasks/` and `-race`. Expected: PASS.
- [ ] **Step 5:** Docs. **Commit** `feat(webui): combined task unread count, linked resources and task scope`.

### Task 6: UI event metadata, Tasks subfilters, "(edited)"

**Files:**
- Modify: `ui/src/lib/eventMeta.tsx`, `ui/src/lib/eventTypeFilter.ts`, `ui/src/api/types.ts` (`TimelineEvent.edited_at?: string`), `ui/src/components/EventRow.tsx`
- Test: `ui/src/lib/eventMeta.test.ts`, `ui/src/lib/eventTypeFilter.test.ts` (create if missing), `ui/src/components/EventRow.test.tsx`, `ui/src/components/EventTypeFilter.test.tsx`

**Interfaces:**
- Produces: `eventMeta("task_work_logged")` → task accent, a pencil or notes icon (`IconNotes`), label `work logged`. `EVENT_CATEGORIES.task` = the three categories from Global Constraints. EventRow shows `(edited)` next to the time when `e.edited_at` is set.

- [ ] **Step 1: Write failing tests:**
  - `categoriesFor(["task"])` returns keys `["progress","blockers","lifecycle"]` with the exact types; `eventTypesFor(["task"], ["blockers"])` → `["task_blocker_resolved","task_blocker_unresolved"]`;
  - every type in `eventMeta.tsx`'s task section appears in exactly one category (guards future types);
  - the EventTypeFilter renders three buttons under the Tasks source;
  - an EventRow with `edited_at` shows "(edited)", and one without doesn't.
- [ ] **Step 2: Run** `cd ui && npm test -- eventTypeFilter eventMeta EventRow EventTypeFilter`. Expected: FAIL.
- [ ] **Step 3: Implement.** Update the comment on the old single `task` category.
- [ ] **Step 4: Run** the same, plus `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): task event subfilters and work log metadata`.

### Task 7: Log work popover in the task sidebar

**Files:**
- Create: `ui/src/components/tasks/modal/LogWorkButton.tsx`
- Modify: `ui/src/components/tasks/modal/TaskSidebar.tsx` (render it directly under the State select), `ui/src/api/client.ts`, `ui/src/hooks/useTaskDetail.ts`
- Test: `ui/src/components/tasks/modal/LogWorkButton.test.tsx`

**Interfaces:**
- Consumes: Task 2's routes.
- Produces:
  - `api.logWork(id: number, text: string) => Promise<TaskDetail>`, `api.editWorkLog(eventId: number, text: string) => Promise<TaskDetail>`, `api.deleteWorkLog(eventId: number) => Promise<TaskDetail>`
  - `useTaskDetailMutations(id)` gains `logWork(text)`, `editWorkLog(eventId, text)` and `deleteWorkLog(eventId)` via `run(...)`. They also invalidate `["tasks","activity"]` and `["timeline"]`.
  - The work log event id for the API is the number after the `TimelineEvent.id` prefix (`unread.TaskEventID`). Add `taskEventNumericId(e: TimelineEvent): number | null` in `ui/src/lib/taskEventKey.ts`.
  - `<LogWorkButton taskId={number} />`

- [ ] **Step 1: Write failing tests:** clicking "Log work" opens a popover with a focused textarea; Save is disabled while the text is blank; typing then ⌘/Ctrl+Enter calls `api.logWork(id, text)` and closes the popover; Esc closes the popover and does not call `onClose` of an enclosing Modal; on rejection the text stays and the error text shows.
- [ ] **Step 2: Run** `cd ui && npm test -- LogWorkButton`. Expected: FAIL.
- [ ] **Step 3: Implement** with a Mantine `Popover` (`trapFocus`, `closeOnEscape`, `withinPortal`) and an autosizing `Textarea` (`minRows={3}`, `maxLength={4000}`).
- [ ] **Step 4: Run** the same plus `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): log work from the task modal`.

### Task 8: Edit and delete work logs in EventDetailsModal; hide Make task when stacked

**Files:**
- Create: `ui/src/components/WorkLogEditor.tsx`
- Modify: `ui/src/components/EventDetailsModal.tsx`
- Test: `ui/src/components/WorkLogEditor.test.tsx`, `ui/src/components/EventDetailsModal.test.tsx`
- Docs: "Event details modal"

**Interfaces:**
- Consumes: Task 7's API and `taskEventNumericId`.
- Produces:
  - `EventDetailsModal` prop `inTask?: boolean`: hides "Make task" (ignores `onMakeTask`); every other action stays.
  - `EventDetailsModal` prop `editable?: boolean` (default true): when false, no Edit (used by the deleted-task fallback in Task 9).
  - For `e.type === "task_work_logged"` and `editable`: an Edit button swaps the body for `<WorkLogEditor event={e} onSaved={(next: TimelineEvent) => void} onDeleted={() => void} onCancel={() => void} />` with Save, Cancel and Delete (inline "Delete? Yes / No"). After a save, the modal shows the new body and "(edited)" using the edited event built from the response. After a delete, `onClose()`.

- [ ] **Step 1: Write failing tests:** Edit appears only for `task_work_logged`; Save calls `api.editWorkLog(<numeric id>, text)` and the body shows the new text with "(edited)"; Delete → Yes calls `api.deleteWorkLog` and closes; Delete → No keeps it; `inTask` hides "Make task" even with `onMakeTask` passed; `editable={false}` hides Edit.
- [ ] **Step 2: Run** `cd ui && npm test -- WorkLogEditor EventDetailsModal`. Expected: FAIL.
- [ ] **Step 3: Implement.** The edited event's body and `edited_at` come from the response: find the event in a refetch of `api.taskActivity(taskId, "task")`, or patch locally with `edited_at = new Date().toISOString()` and let invalidation correct it. Pick one and comment why.
- [ ] **Step 4: Run** the same plus `npx tsc -b`. Expected: PASS.
- [ ] **Step 5:** Docs. **Commit** `feat(ui): edit and delete work logs in event details`.

### Task 9: Stacked details from the Activity tab; feeds open task → Activity → event

**Files:**
- Modify: `ui/src/components/tasks/modal/TaskModalProvider.tsx`, `TaskDetailModal.tsx`, `ActivityTab.tsx`
- Modify: `ui/src/components/ActivityPanel.tsx` (the event-row `onOpenTask` no longer uses `pickTask`; search picks keep `pickTask`), `ui/src/components/ResourceDetailPane.tsx`, `ui/src/pages/WorktreeDetailPage.tsx`, and any other `onOpenTask` passed to `TimelineFeed`/`EventRow` (grep `onOpenTask=`)
- Test: `TaskModalProvider` test (create if missing), `TaskDetailModal.test.tsx`, `ActivityTab.test.tsx`, `ActivityPanel.test.tsx`
- Docs: "Task detail modal" (rows no longer inert; open-with-event; stacking), ActivityPanel notes

**Interfaces:**
- Produces:
  - `TaskModal.open(id: number, opts?: { error?: string; event?: TimelineEvent })`. With `event`, the modal opens on the Activity tab and shows that event's `EventDetailsModal` stacked. The event is held in provider state keyed by task id, and is **not** put in the URL.
  - `TaskModal.focusEvent: TimelineEvent | null` and `clearFocusEvent(): void` (read and cleared by `TaskDetailModal`).
  - `ActivityTab` prop `initialEvent?: TimelineEvent | null`. It owns `const [details, setDetails] = useState<TimelineEvent | null>(initialEvent ?? null)`. Row click → `setDetails(e)`. It renders `<EventDetailsModal e={details} inTask onClose={() => setDetails(null)} />`. The link toggles keep `stopPropagation` so a toggle click doesn't open details. A task event row **for this same task** opens details (it does not call `open`).
  - Feeds: `onOpenTask={(id, e) => openTask(id, { event: e })}` everywhere a feed row opens a task, the home page included (in place, per spec §4).
  - Fallback: if `useTaskDetail(openId)` errors with 404 while `focusEvent` is set, `TaskDetailModal` renders `<EventDetailsModal e={focusEvent} editable={false} onClose={close} />` instead of the error state.

- [ ] **Step 1: Write failing tests:**
  - `open(7, { event: e })` → the modal shows the Activity tab selected and an EventDetailsModal with `e.title`. Closing the details leaves the task modal open on Activity. Closing again closes the task modal.
  - **Esc layering:** with details stacked, `fireEvent.keyDown(document.activeElement, { key: "Escape" })` closes only the details modal; a second Esc closes the task modal.
  - An ActivityTab row click opens details with `inTask` (no "Make task" button); a link-toggle click does not open details.
  - ActivityPanel (home): clicking a task event row calls `open(id, { event })` and does **not** navigate, even when `worktree_paths` has 1 or 2 entries. A task picked from search still navigates as before.
  - Fallback: `open(99, { event })` with detail fetch → 404 shows the event details without Edit.
- [ ] **Step 2: Run** `cd ui && npm test -- TaskModalProvider TaskDetailModal ActivityTab ActivityPanel`. Expected: FAIL.
- [ ] **Step 3: Implement.** If Mantine's nested Esc doesn't isolate on its own, fix it in the stacked modal (`closeOnEscape` on the top one plus `stopPropagation` in its `onKeyDown`) rather than in every caller.
- [ ] **Step 4: Run** the same, the full `npm test`, and `npx tsc -b`. Expected: PASS.
- [ ] **Step 5:** Docs (replace the "linked-event rows are inert" sentence and the `ActivityTab` comment). **Commit** `feat(ui): open event details from the task Activity tab and from feeds`.

### Task 10: Unread surfaces — Activity tab badge and task row highlight

**Files:**
- Modify: `ui/src/api/types.ts` (`Task.combined_unread_count?: number`, `TaskDetail.linked_resources: ResourceDTO[]`, `TaskScope` adds `{ kind: "task"; id: number }`), `ui/src/api/client.ts` (`taskScopeParams` handles `task` → `id`)
- Modify: `ui/src/components/tasks/modal/TaskDetailModal.tsx` (tab label), `ui/src/components/tasks/TaskRow.tsx`
- Test: `TaskDetailModal.test.tsx`, `TaskRow.test.tsx`
- Docs: "Task lists in the UI", "Task detail modal"

**Interfaces:**
- Consumes: `combined_unread_count` (Task 5); `UnreadBadge` (`ui/src/components/UnreadBadge.tsx`); the worktree card's unread border and tint (`UNREAD_BOX_BORDER` and related in `ui/src/lib/unread`).

- [ ] **Step 1: Write failing tests:** with `combined_unread_count: 3`, the Activity tab label contains an `UnreadBadge` reading 3, and with 0 or absent there's no badge. A TaskRow with `combined_unread_count > 0` has the unread border style and the dot; with `unread_count: 2, combined_unread_count: 0` (impossible but defensive) it shows neither. Dot label "unread activity".
- [ ] **Step 2: Run** `cd ui && npm test -- TaskDetailModal TaskRow`. Expected: FAIL.
- [ ] **Step 3: Implement.** Read `combined_unread_count ?? unread_count ?? 0`, so an older server still shows its own count.
- [ ] **Step 4: Run** the same plus `npx tsc -b`. Expected: PASS.
- [ ] **Step 5:** Docs. **Commit** `feat(ui): task unread badge and row highlight`.

### Task 11: Mark all read in the task modal

**Files:**
- Modify: `ui/src/components/MarkAllReadButton.tsx` (task preview source), `ui/src/components/tasks/modal/TaskModalHeader.tsx` (replace Mark read)
- Check/Modify: `ui/src/hooks/useMarkSlackEventRead.ts`, `ui/src/components/slack/ThreadView.tsx`, and any per-resource mark read, so each invalidates `["tasks"]`
- Test: `ui/src/components/MarkAllReadButton.test.tsx`, `TaskModalHeader.test.tsx`
- Docs: "Task detail modal", "Unread"

**Interfaces:**
- Consumes: `TaskScope {kind:"task"}`, `TaskDetail.linked_resources`, paged `useTaskActivity` (Task 4).
- Produces:
  - `MarkAllReadFeed` gains `task?: number`. When it's set, the preview column reads `useTaskActivity(task, { filter: "all" })` and shows only rows with `e.unread` whose source is checked (watcher rows by `resource_type`; task rows when the task row is checked). There's a load-more control while `hasMore`.
  - `TaskModalHeader` renders `<MarkAllReadButton resources={task.linked_resources} feed={{ task: task.id, showResource: true }} taskScope={{ kind: "task", id: task.id }} />` while `(task.combined_unread_count ?? 0) > 0`. Its label is "Mark all read". The old `useMarkTaskRead` button is removed.

- [ ] **Step 1: Write failing tests:**
  - The header shows "Mark all read" when the combined count > 0 and nothing when it's 0.
  - Opening it lists a GitHub row (from `linked_resources` with unread) and the task row (from `api.taskUnread({kind:"task", id})`), both checked. Confirming calls the resource mark (existing API) and `api.taskRead({id, through_ts})`. Unchecking GitHub skips it.
  - The preview shows unread rows from the task activity mock only.
  - After a Slack thread mark read (`useMarkSlackEventRead`), `["tasks"]` is invalidated.
- [ ] **Step 2: Run** `cd ui && npm test -- MarkAllReadButton TaskModalHeader useMarkSlackEventRead`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full `npm test` and `npx tsc -b`, then `make build` from the worktree root. Expected: PASS, and the build succeeds.
- [ ] **Step 5:** Docs. **Commit** `feat(ui): mark all read from the task modal`.

### Task 12: Whole-branch verification

- [ ] **Step 1:** `make test` and `go test -race ./internal/webui/`. Expected: PASS.
- [ ] **Step 2:** `cd ui && npx tsc -b && npm test`. Expected: PASS.
- [ ] **Step 3:** `make build`. Expected: success.
- [ ] **Step 4:** Run the app against the worktree's ports (`make dev`, which uses ports in `WORKTREE_PORTS` 4050-4059 if configurable; otherwise ask Mike) and walk the flows: log work → it appears in Activity and on the home feed under Tasks › Progress → open it from home (task → Activity → details) → edit → "(edited)" → delete. Badge and row highlight with an unread linked PR → Mark all read clears both. Esc closes one layer at a time. Never kill an mprocs process you didn't start.
