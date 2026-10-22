# Tasks Phase 3 — Detail Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task detail modal with Details and Activity tabs and a properties sidebar. It is opened from any task row, from quick add's "Add & open", from "＋ task" on activity events and Slack messages, and from a `?task=<id>` URL. In it you can edit everything Phase 1 stores, plus links to specific events.

**Architecture:**
- Backend: `internal/tasks` gains event links (an id plus a snapshot). `internal/webui/tasks_detail_api.go` serves one detail DTO, every edit endpoint, and a merged activity feed. That feed converts task events to the existing `TimelineEvent` shape, through a converter that Phase 4 reuses for all feeds.
- Frontend: one `TaskModalProvider` at the app root owns "which task is open", mirrored to a `task` URL query param. The modal is composed from small panels in `ui/src/components/tasks/modal/`.

**Tech Stack:** Go, React + Mantine 7, TanStack Query, dnd-kit (subtask and link reordering), the existing `NotesMarkdown` and `EventRow`.

**Spec:** `docs/superpowers/specs/2026-10-21-tasks-design.md`, sections "Task detail modal", "Links", "Linked events" and "Task activity". The tracker is the spec's "Phases" table: set Phase 3 to "done" in the final commit. Decisions the user hasn't approved go in `docs/superpowers/specs/2026-10-21-tasks-autonomous-decisions.md`, under a "Phase 3" heading.

**Not in this phase:** blockers in the sidebar (Phase 5), task events in the home/worktree/resource feeds and unread (Phase 4), and undo toasts (Phase 6). Delete is a soft delete here, with no undo yet.

## Global Constraints

- Modal header: the state checkbox (the same three-state menu as the row) · the star · the title, editable in place (click, then Enter or blur saves, Esc cancels) · close. Two tabs: **Details** and **Activity**. A **sidebar** stays visible on both tabs.
- Sidebar: State, Priority, Due date (native `<input type="date">`, clearable), Starred, then the Created / Started / Updated / Completed timestamps, then **Delete**. Blocked-by is a placeholder area reserved for Phase 5 and renders nothing now.
- Details tab, in this order: **Description** (markdown rendered with `NotesMarkdown`; an Edit button switches to a textarea; Save/Cancel), **Subtasks** ("n/m", add, check, edit in place, remove, drag to reorder), **Linked to** (Focus and Related groups, draggable within and between, each removable; "+ Link resource or worktree"; implicit worktrees shown dashed and read-only, with "via <ref>"), **Linked events** (rendered as event rows from their snapshot; "Open" goes to the URL; unlink).
- Activity tab: the task's own events merged with every event from its linked resources, newest first. Filter pills: **Everything**, **This task only**, **Linked events**, plus one pill per linked resource. Each resource event has a 🔗 link/unlink toggle.
- Event links store an identity plus a **snapshot**: source, type, title, author, a body excerpt (≤ 500 chars), URL, `ts`, resource type and id. A row renders from the live event when it still exists with the same type, and from the snapshot otherwise. Slack messages use the identity key `slack:<channel>:<message_ts>`. Watcher events use `ev:<watcher_events.id>`.
- "＋ task" creates a task titled from the event (the event title; for Slack messages, the first line of the text, trimmed to 120 chars), Focus-linked to the event's resource, with the event linked. It then opens the modal.
- Opening the modal sets the `task=<id>` query param, so the modal is linkable and closes with the browser's Back button. Closing removes the param.
- **Row click guards** (carried over from Phase 2's review): the row opens the modal. The checkbox (including its menu items, which render in a PORTAL; React events bubble through portals), the star, the grip (pointerdown, and the click that follows a drag), the link chip and quick add must not open it. The title is a real `button`, so the keyboard can open it.
- Every web write uses `tasks.Actor{Kind: tasks.ActorUser}`. Every task write already bumps `tasks.Version`, so open modals refresh on `tasks_changed`.
- Commits: `git commit --signoff`, with the trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01HAFCNa6UnHnRzp1mmxFzto`. Add files by name. Use `./cmd/...` in `go test`, never `./cmd/`. Don't merge to main or push.

## Review Focus

1. **A linked event pruned or rewritten by the watcher.** The row must still render, from its snapshot. Test: `TestEventLinkRendersFromSnapshot` (Task 2).
2. **A click on a checkbox menu item bubbling through the portal and opening the modal.** Test: the TaskRow guard test (Task 6).
3. **Two edits racing**, e.g. a title edit in progress while an agent changes the task. The in-progress title edit must not be overwritten while the input has focus. Test: the TaskModalHeader test (Task 4).
4. **Linking a resource by URL that no worktree follows.** It is allowed, and it shows as archived. Test (Task 2).
5. **A `?task=` for a missing or deleted id.** Show "Task not found" with a close button, rather than crashing. Test (Task 4).

---

### Task 1: Event links in `internal/tasks`

**Files:**
- Modify: `internal/db/migrate.go` (table `task_event_links`)
- Create: `internal/tasks/eventlinks.go`, `internal/tasks/eventlinks_test.go`
- Modify: `internal/tasks/events.go` (constants `task_event_linked`, `task_event_unlinked`)

**Interfaces:**
- Produces:

```go
type EventSnapshot struct {
	Source, Type, Title, Author, Body, URL, TS, ResourceType, ResourceID string // Body is truncated to 500 runes on write
}
type EventLink struct{ Key string; Snapshot EventSnapshot; CreatedAt string }
func LinkEvent(conn *sql.DB, a Actor, taskID int64, key string, snap EventSnapshot) error   // idempotent: re-linking the same key is a no-op (no event)
func UnlinkEvent(conn *sql.DB, a Actor, taskID int64, key string) error                    // ErrNotFound if it isn't linked
func EventLinks(conn *sql.DB, taskID int64) ([]EventLink, error)                             // oldest first
func TasksLinkingEvent(conn *sql.DB, key string) ([]int64, error)                          // for "already linked" UI
```

Schema:

```sql
CREATE TABLE IF NOT EXISTS task_event_links (
	task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	event_key  TEXT NOT NULL,
	snapshot   TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (task_id, event_key)
);
```

Writes go through `inTx`, which handles the version bump, and record the event with payload `{"key", "title"}`. Validation: the key is non-empty and starts with `ev:` or `slack:`, otherwise `ErrInvalid`. The task must exist and not be deleted.

- [ ] **Step 1: Write the failing tests:** link, list and unlink round-trip; re-linking is a no-op with no second event; unlinking a missing key gives ErrNotFound; a bad key prefix gives ErrInvalid; a 2000-char body is stored as 500 runes; deleting the task (hard delete via SQL in the test) cascades.
- [ ] **Step 2: Run** `go test ./internal/tasks -run EventLink` and expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test ./internal/tasks ./internal/db ./cmd/...` and expect PASS.
- [ ] **Step 5: Commit**: `feat(tasks): link tasks to specific activity events with a snapshot`

---

### Task 2: Detail, edit and activity endpoints

**Files:**
- Create: `internal/webui/tasks_detail_api.go`, `internal/webui/tasks_detail_api_test.go`
- Create: `internal/webui/task_timeline.go` (task event → `TimelineEvent`; Phase 4 reuses it)
- Modify: `internal/webui/server.go` (routes), `docs/web-ui-architecture.md` (API rows plus a short section)

**Interfaces:**
- Consumes: `internal/tasks` (everything, including Task 1). The existing `TimelineEvent` and `eventEnricher` in `timeline.go`. `eventIDsForResource`. `resourceurl.InferAny`.
- Produces:

```go
type taskDetailLinkDTO struct {
	taskLinkDTO
	Title string `json:"title"`         // the resource's custom_name, else its cached title, else its short ref; a worktree's branch, else its basename
	URL   string `json:"url,omitempty"` // the resource URL
}
type taskImplicitDTO struct{ Worktree string `json:"worktree"`; Branch string `json:"branch,omitempty"`; Via []string `json:"via"` } // via = "type:id" keys
type taskSubtaskDTO struct{ ID int64 `json:"id"`; Text string `json:"text"`; Checked bool `json:"checked"` }
type taskEventLinkDTO struct {
	Key string `json:"key"`; Snapshot tasks.EventSnapshot `json:"snapshot"` /* snake_case JSON tags on EventSnapshot */
	Live *TimelineEvent `json:"live,omitempty"` // present when the watcher event still exists with the same type
}
type taskDetailDTO struct {
	taskDTO
	DetailLinks  []taskDetailLinkDTO `json:"detail_links"`  // same order as Links
	ImplicitVia  []taskImplicitDTO   `json:"implicit"`
	Subtasks     []taskSubtaskDTO    `json:"subtasks"`
	EventLinks   []taskEventLinkDTO  `json:"event_links"`
}
func taskEventToTimeline(ev tasks.Event, t tasks.Task) TimelineEvent // id "task:<event id>", source "tasks", type = ev.Type, title human-readable (e.g. "Started “<title>”", "Linked #4521"), author = "you" for user, else "agent" plus the session in parentheses; resource_type "task", resource_id "<task id>", resource_title = task title
```

Routes. Every POST body is capped at 64 KiB and returns the fresh `taskDetailDTO` unless stated otherwise:

| Method | Path | Body / params |
|---|---|---|
| GET | `/api/tasks/detail` | `id` → `taskDetailDTO` (404 if missing or deleted) |
| GET | `/api/tasks/activity` | `id`, `filter=all\|task\|linked\|resource`, `type`/`rid` (with `filter=resource`) → `[]TimelineEvent`, newest first, each resource event carrying `linked_to_task bool` (a new omitempty field on `TimelineEvent`) |
| POST | `/api/tasks/update` | (Phase 2's route) also accepts `description` |
| POST | `/api/tasks/delete` | `{id}` → 204 |
| POST | `/api/tasks/links/add` | `{id, url?, type?, rid?, path?, focus?}`. Exactly one of url, type+rid, path. A URL resolves with `resourceurl.InferAny`; an unknown URL is 400 |
| POST | `/api/tasks/links/remove` | `{id, kind, type?, rid?, path?}` |
| POST | `/api/tasks/links/focus` | `{id, kind, type?, rid?, path?, focus}` |
| POST | `/api/tasks/links/order` | `{id, focus:[target...], related:[target...]}` |
| POST | `/api/tasks/subtasks/add` | `{id, text}` |
| POST | `/api/tasks/subtasks/edit` | `{subtask_id, text}` |
| POST | `/api/tasks/subtasks/check` | `{subtask_id, checked}` |
| POST | `/api/tasks/subtasks/remove` | `{subtask_id}` |
| POST | `/api/tasks/subtasks/order` | `{id, ids:[...]}` |
| POST | `/api/tasks/events/link` | `{id, key, snapshot}`. For `ev:` keys the server rebuilds the snapshot from `watcher_events` (it ignores the client's), so snapshots stay truthful. For `slack:` keys it takes the client snapshot |
| POST | `/api/tasks/events/unlink` | `{id, key}` |
| POST | `/api/tasks/from-event` | `{key, snapshot?, path?}` creates the task (title rule from Global Constraints, a Focus link to the event's resource, the event linked) and returns `taskDetailDTO` |

The activity feed merges `tasks.Events(id)` (converted) with watcher events for every linked resource (via `eventIDsForResource`, enriched like the timeline). It is limited to 200, newest first by `ts`.

- [ ] **Step 1: Write the failing tests:**
  - detail includes titles, implicit-via and subtasks
  - `TestEventLinkRendersFromSnapshot`: an `ev:` link whose watcher event row is deleted still returns its snapshot with no `live`
  - activity filters (`task` returns only task events; `linked` returns only linked events' live rows; `resource` returns one resource)
  - `linked_to_task` flags
  - links/add by URL for a PR no worktree follows gives a link that is `archived: true`
  - from-event builds the right title, Focus link and event link
  - error mapping (400/404)
  - Focus 404 on a missing link (ErrLinkNotFound)
- [ ] **Step 2: Run** `go test ./internal/webui -run 'TaskDetail|TaskActivity|EventLink|FromEvent'` and expect FAIL.
- [ ] **Step 3: Implement.** Reuse `writeTaskError`, `decodeTaskBody` and `newTaskDTO` from `tasks_api.go`.
- [ ] **Step 4: Run** `go test ./internal/webui ./internal/tasks` and expect PASS.
- [ ] **Step 5: Commit**: `feat(webui): task detail, edit, event-link and activity endpoints`

---

### Task 3: Frontend data layer for the modal

**Files:**
- Modify: `ui/src/api/types.ts`, `ui/src/api/client.ts`
- Create: `ui/src/hooks/useTaskDetail.ts` (`useTaskDetail(id)`, `useTaskActivity(id, filter)`, `useTaskDetailMutations(id)`)
- Test: `ui/src/hooks/useTaskDetail.test.tsx`

**Interfaces:**
- Produces: query keys `["tasks", "detail", id]` and `["tasks", "activity", id, filter]`. They sit under the `"tasks"` root, so `tasks_changed` and every list mutation's invalidation already refresh them. Mutation functions map one-to-one onto Task 2's routes, and each invalidates `["tasks"]`, `["worktrees"]` and `["resources"]` once it settles. `fromEvent(key, snapshot?, path?)` returns the new detail.

- [ ] **Step 1: Write the failing tests:** each mutation posts the right body; the detail query refetches after a mutation; activity keys include the filter.
- [ ] **Step 2: Run** `cd ui && npx vitest run src/hooks/useTaskDetail.test.tsx` and expect FAIL.
- [ ] **Step 3: Implement**, following `useTasks.ts`.
- [ ] **Step 4: Run** `cd ui && npx vitest run src/hooks && npx tsc --noEmit` and expect PASS.
- [ ] **Step 5: Commit**: `feat(ui): task detail data hooks`

---

### Task 4: Modal shell — provider, URL state, header, sidebar

**Files:**
- Create: `ui/src/components/tasks/modal/TaskModalProvider.tsx` (context with `open(id)`, `close()` and `openId`; reads and writes the `task` query param through wouter, like `useSelectedResource` does)
- Create: `ui/src/components/tasks/modal/TaskDetailModal.tsx`, `TaskModalHeader.tsx`, `TaskSidebar.tsx`
- Modify: `ui/src/App.tsx` (mount the provider and the modal once, inside the router)
- Test: `ui/src/components/tasks/modal/TaskDetailModal.test.tsx`

**Interfaces:**
- Produces: `export function useTaskModal(): { openId: number | null; open(id: number): void; close(): void }`.
- The modal is a Mantine `Modal` (`size="xl"`). It renders the header, the Details and Activity tabs (bodies supplied by Tasks 5 and 7; a placeholder here), and the sidebar.
- **Title editing:** a local draft is kept while the input is focused. A server refetch never overwrites the draft. Enter or blur saves, and Esc reverts.
- **Sidebar:** each control saves on change. The due date uses `<input type="date">` plus a clear button. Delete asks for confirmation (Mantine `modals` is not installed, so use a small inline "Delete? Yes / No"), then closes the modal.
- **Missing task:** a missing or deleted id shows "Task not found" with a close button.

- [ ] **Step 1: Write the failing tests:**
  - `?task=5` opens the modal for task 5, and closing removes the param
  - editing the title and pressing Enter calls update; Esc reverts
  - a refetch while the title input is focused doesn't overwrite the draft
  - sidebar priority and due changes call update; clearing the due date sends `due: ""`
  - delete with confirmation calls delete and closes
  - an unknown id shows "Task not found"
- [ ] **Step 2: Run** `cd ui && npx vitest run src/components/tasks/modal` and expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd ui && npx vitest run && npx tsc --noEmit` and expect PASS.
- [ ] **Step 5: Commit**: `feat(ui): task detail modal shell, URL state, header and sidebar`

---

### Task 5: Details tab — description, subtasks, links, linked events

**Files:**
- Create in `ui/src/components/tasks/modal/`: `DetailsTab.tsx`, `DescriptionSection.tsx`, `SubtasksSection.tsx`, `LinksSection.tsx`, `LinkPicker.tsx`, `LinkedEventsSection.tsx`
- Test: one `*.test.tsx` per section

**Interfaces:**
- Consumes: `useTaskDetail`, `useTaskDetailMutations`, `NotesMarkdown`, `EventRow` (render a linked event as an `EventRow` from `live`, or from a `TimelineEvent` built out of the snapshot when `live` is absent), dnd-kit (copy `ResourceList`'s sensors and grip pattern).
- **LinkPicker:** a combobox. It suggests the resources followed by the task's worktrees (direct and implicit), from `api.worktreeResources(path)` for each worktree, or from all resources for a global task, plus every worktree from `useWorktrees()`. It also accepts a pasted URL. The choice adds the link as Related by default.
- **Subtasks:** add on Enter keeps focus. Checking writes immediately. Click the text to edit in place. Drag reorder calls `subtasks/order`.
- **Links:** Focus and Related are two SortableContexts in one DndContext. A cross-group drop calls `links/order` with both groups in full. Each link has remove (✕) and "make Focus/Related" in a hover menu. Implicit worktrees show dashed and read-only, with "via #4521, RHOAIENG-1".

- [ ] **Step 1: Write the failing tests:** description edit and save; subtask add, check, edit and remove, plus keyboard reorder through the real DnD handler; adding a link by picker choice and by pasted URL; a cross-group link drop sends the full order; implicit rows are read-only; a linked event row renders from its snapshot when `live` is absent; unlink.
- [ ] **Step 2: Run** `cd ui && npx vitest run src/components/tasks/modal` and expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd ui && npx vitest run && npx tsc --noEmit` and expect PASS.
- [ ] **Step 5: Commit**: `feat(ui): task modal Details tab — description, subtasks, links, linked events`

---

### Task 6: Opening the modal — row click guards and "Add & open"

**Files:**
- Modify: `ui/src/components/tasks/TaskRow.tsx`. The title becomes a `button` that calls `open(task.id)`, and a click anywhere else on the row also opens it. Guard the checkbox, its menu (stopPropagation on `Menu.Dropdown`'s `onClick` as well as the trigger's), the star, the grip (pointerdown, and suppressing the click after a drag), and the link chip.
- Modify: `ui/src/components/tasks/TaskQuickAdd.tsx`, adding "Add & open" to the right of Add (same WebKit `onMouseDown` preventDefault). It creates the task, then calls `open(newId)`.
- Test: `TaskRow.test.tsx`, `TaskQuickAdd`/`TaskList` tests

- [ ] **Step 1: Write the failing tests:** a row click opens; Enter on the focused title opens; clicking the checkbox, picking a state from its portalled menu, clicking the star, and clicking the grip all do NOT open; "Add & open" creates the task and opens the new id.
- [ ] **Step 2: Run** them and expect FAIL. **Steps 3–4:** implement, then `cd ui && npx vitest run && npx tsc --noEmit` and expect PASS.
- [ ] **Step 5: Commit**: `feat(ui): open the task modal from rows and from quick add`

---

### Task 7: Activity tab, and "＋ task" from events and Slack messages

**Files:**
- Create: `ui/src/components/tasks/modal/ActivityTab.tsx` (filter pills, event rows, and a per-row 🔗 toggle for resource events)
- Modify: `ui/src/components/EventRow.tsx`, adding a "＋ task" hover action. The row is a single button (see its doc comment), so the action must sit OUTSIDE that button: wrap the row in a container and position the action beside it. Don't nest buttons.
- Modify: `ui/src/components/EventDetailsModal.tsx` (a "Make task" button)
- Modify: `ui/src/components/slack/Message.tsx` (a "Make task" hover action beside "copy link"; the key is `slack:<channel>:<ts>`, and the snapshot comes from the message: author name, text, permalink, ts, plus the thread resource)
- Test: `ActivityTab.test.tsx`, `EventRow.test.tsx`, `Message.test.tsx`

Each "Make task" calls `fromEvent(...)`, then `open(newId)`.

- [ ] **Step 1: Write the failing tests:** the pills change the activity query filter; the 🔗 toggle calls link/unlink with an `ev:` key; "＋ task" on an EventRow calls fromEvent and opens the modal without triggering the row's own click; Slack "Make task" sends a `slack:` key with a snapshot.
- [ ] **Step 2: Run** them and expect FAIL. **Steps 3–4:** implement, then `cd ui && npx vitest run && npx tsc --noEmit` and expect PASS.
- [ ] **Step 5: Commit**: `feat(ui): task Activity tab and make-task from events and Slack messages`

---

### Task 8: Docs, tracker, decisions

**Files:**
- Modify: `docs/web-ui-architecture.md` (a "Task detail modal" subsection: provider and URL param, the sections, the event-link snapshot rule, and the row guards including the portal note)
- Modify: `docs/superpowers/specs/2026-10-21-tasks-design.md` (Phase 3 is `done`, with the plan path)
- Modify: `docs/superpowers/specs/2026-10-21-tasks-autonomous-decisions.md` (a "Phase 3" section listing every judgement call made in Tasks 1–7, taken from the task reports)

- [ ] **Step 1: Update the docs.** **Step 2:** run `make build && go test ./... && (cd ui && npx vitest run && npx tsc --noEmit)` and expect PASS.
- [ ] **Step 3: Commit**: `docs: document the task detail modal; mark Tasks Phase 3 done`
