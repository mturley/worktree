# Tasks Phase 2 — Task Lists in the UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, add, reorder and update tasks in the web UI. That means a Tasks tab (or a pinned panel) on the home page, the worktree page and every selected resource, with compact rows, quick add, sort/filter, a starred group, drag reordering, and task-count badges.

**Architecture:** A small JSON API over `internal/tasks` (Phase 1) in `internal/webui/tasks_api.go`. A `tasks_changed` SSE signal is driven by a version counter that every task write bumps. On the frontend, pure list logic (grouping, sorting, drop planning, due labels) lives in `ui/src/lib/taskList.ts`, so it can be unit-tested away from React. The UI is one `TaskList` component used everywhere, wrapped by a `TasksSection` that decides between "tab" and "pinned" from a single global pref.

**Tech Stack:** Go (`net/http`, `internal/tasks`), React + Mantine + TanStack Query + dnd-kit (all already in `ui/`), vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-21-tasks-design.md` (sections "Ordering", "UI", and "Where tasks show up"). The spec's "Phases" table is the tracker: set Phase 2 to "done" there in the final commit.

**Not in this phase:** the detail modal (so no "Add & open" button, and clicking a row does nothing yet), linked events and "＋ task" (Phase 3), task events in feeds and unread (Phase 4), blockers (Phase 5; the row's blocked chip arrives then), and undo (Phase 6).

## Global Constraints

- The task accent is **electric lime `#a3e635`**. Keep it in ONE token (a CSS variable `--task-accent`, plus `TASK_ACCENT` in `ui/src/theme.ts`) so yellow `#facc15` and orange `#fb923c` can be compared later by changing one value. Never use blue for tasks, because blue means unread.
- Task panels have a faint lime background, a lime border and a 3px lime left edge. Count badges are lime with dark text.
- Row, left to right: drag grip (shown on hover) · state checkbox · star · priority marker (`!!!` red / `!!` amber / `!` grey / blank) · title (one line, ellipsised) · chips: due, subtask progress `n/m`, link chip.
- State checkbox: empty = not started, **diagonally half-filled** = in progress, filled ✓ = done. A click opens a menu of the three states and **changes nothing until one is picked**.
- Due chip, relative: "Due today", "Due tomorrow", "N days left", "Overdue N days" (with the singular "1 day"). The absolute date shows on hover. Overdue is red, today is amber, and the rest are neutral.
- Link chip: the **first Focus link** plus "+N" counting all other links. When there are links but no Focus, show "🔗 N linked". A worktree link renders as `⎇ <basename>`. An archived link is dashed and says "archived". On a resource's own list, omit the chip when its first Focus link is that resource.
- Starred tasks are grouped at the top. Dragging into the starred group stars a task, and dragging out unstars it.
- Sort options: **Custom** (master order; the default), **Priority** (High/Medium/Low/None groups, each in master order; dragging across groups changes priority), **Due date**, **Recently updated**. Dragging is disabled outside Custom and Priority, with a hint.
- "Show completed" adds a **Completed** group at the bottom, newest `completed_at` first, not draggable. "Include archived" is its sub-toggle.
- Tab order: Tasks is **always the last tab**. The home page is Activity · Resources · Tasks. The worktree page with nothing selected is Activity · Tasks (narrow: Resources · Activity · Tasks). PR/Jira is Activity · Linked Resources · Tasks. Slack is Thread · Linked Resources · Tasks. A link is Details · Tasks.
- When the Tasks tab isn't active and the list isn't pinned, the tab shows a lime count of open tasks.
- Pinning is ONE global preference. Pinned, the list sits just above the tab bar (on a resource, between the resource card and its tab bar), and its header carries the toolbar plus Unpin. The Tasks tab disappears. The pinned list caps at about 8 rows and scrolls inside itself. The Pin button sits in the Tasks tab bar's right-hand toolbar, with sort, priority filter and show completed.
- Quick add, at the bottom of every list, is just an input until it is focused or has text. Then a star toggle and a priority picker appear to its LEFT and an "Add" button to its RIGHT. Enter adds the task and keeps focus. A new task is placed just after the last visible task, with the current context as a Focus link: nothing on home, the worktree, or the selected resource.
- The existing search box narrows task lists, matching title and description.
- Every web write uses `tasks.Actor{Kind: tasks.ActorUser}`.
- Watcher toggles don't apply: tasks contact no external service.
- Commits: `git commit --signoff`, with message trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01HAFCNa6UnHnRzp1mmxFzto`. Add files by name. Write `./cmd/...` rather than `./cmd/` in go test.
- Don't merge to main. The branch stays `tasks` until all six phases are done.

## Review Focus

1. **A CLI write while the UI is open.** An agent adding or moving a task must show up without a reload. Test: `TestStreamEmitsTasksChanged` (Task 2), and the useSSE invalidation test (Task 3).
2. **Dragging in a filtered or priority-sorted view.** The moved task must land beside the visible neighbour it was dropped next to, and hidden tasks must not move. Test: the `planDrop` cases (Task 4), including an empty destination group.
3. **A drag that fails server-side.** The optimistic order must roll back, not stick. Test: `useTaskMutations` rollback (Task 3).
4. **Due-date boundaries.** Today, tomorrow, yesterday, and a date across a month boundary, all computed in local time, not UTC. Test: `dueLabel` cases (Task 4).
5. **Narrow and pinned layouts together.** Pinning on a narrow screen must not lose the Tasks content. Test: `TasksSection` narrow+pinned (Task 7).

---

### Task 1: Placement on create, change version, and counts in `internal/tasks`

**Files:**
- Modify: `internal/tasks/tasks.go` (`NewTask` gains placement; `Create` honours it)
- Modify: `internal/db/migrate.go` (new `tasks_version` table)
- Modify: `internal/tasks/tasks.go` (`inTx` bumps the version on every successful write)
- Create: `internal/tasks/counts.go`
- Test: `internal/tasks/tasks_test.go`, `internal/tasks/counts_test.go`

**Interfaces:**
- Consumes: Phase 1 `internal/tasks` (`inTx` with BEGIN IMMEDIATE on a dedicated conn, the `dbtx` interface, the list/membership compute path).
- Produces:

```go
// NewTask gains:
After  int64 // place immediately after this task (as MoveAfter); 0 = unset
Before int64 // place immediately before this task (as MoveBefore); 0 = unset
// Both set -> ErrInvalid. Neither -> bottom (Phase 1 behaviour). Placement is in the same transaction as the insert.

func Version(conn *sql.DB) (int64, error) // monotonically increasing; bumped by every committed write in this package

type Counts struct {
	ByWorktree map[string]int // canonical worktree path -> open (not done) tasks in worktree scope (direct, implicit, fallback)
	ByResource map[string]int // "type:id" -> open tasks linking that resource
	Total      int            // open tasks in all scope
}
func OpenCounts(conn *sql.DB) (Counts, error) // ONE load; reuses the list compute path, not a second membership implementation
```

Schema (append to `stmts`):

```sql
CREATE TABLE IF NOT EXISTS tasks_version (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	v  INTEGER NOT NULL
);
INSERT OR IGNORE INTO tasks_version (id, v) VALUES (1, 0);
```

Every `inTx` that commits does `UPDATE tasks_version SET v = v + 1 WHERE id = 1` inside the transaction, right before COMMIT. That includes moves and SetSubtaskOrder, which write no events, so a version counter catches them where an events-based check would not. A version-only signal is enough: the SSE needs "something changed", not what.

- [ ] **Step 1: Write the failing tests**

```go
func TestCreatePlacement(t *testing.T) {
	// A, B, C at the bottom; Create D with After: A.ID -> order A, D, B, C
	// Create E with Before: A.ID -> order E, A, D, B, C
	// After and Before both set -> ErrInvalid, no row; After a missing id -> ErrNotFound, no row
}
func TestVersionBumpsOnEveryWrite(t *testing.T) {
	// v0 := Version; Create -> v0+1; MoveToTop -> +1; SetSubtaskOrder -> +1; a no-op SetState -> unchanged
}
func TestOpenCounts(t *testing.T) {
	// worktree X follows pr:1; task a links pr:1 (open), task b links wt X (open), task c links pr:1 (done), task d global (open)
	// ByWorktree[X] == 2, ByResource["pr:1"] == 1, Total == 3
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test ./internal/tasks -run 'Placement|Version|OpenCounts'`
Expected: FAIL

- [ ] **Step 3: Implement.** A no-op write (one where `inTx`'s fn returned without writing) must not bump the version. Have the write paths that already return early before `inTx` keep doing so, and bump inside `inTx` only when fn returns nil.

- [ ] **Step 4: Run tests**

Run: `go test ./internal/tasks ./internal/db`
Expected: PASS

- [ ] **Step 5: Commit** — `feat(tasks): create-time placement, a change version, and open-task counts`

---

### Task 2: Tasks web API, counts in DTOs, `tasks_changed` SSE

**Files:**
- Create: `internal/webui/tasks_api.go`, `internal/webui/tasks_api_test.go`
- Modify: `internal/webui/server.go` (routes)
- Modify: `internal/webui/stream.go` (emit `tasks_changed`)
- Modify: `internal/webui/worktrees.go` (`worktreeSummary.OpenTaskCount`)
- Modify: `internal/webui/resources_api.go` and `internal/webui/all_resources_api.go` (`OpenTaskCount` on `resourceDTO` / `allResourceDTO`)
- Modify: `docs/web-ui-architecture.md` (API table rows, plus a new "Tasks" section)

**Interfaces:**
- Consumes: Task 1 (`OpenCounts`, `Version`, `NewTask.After/Before`), plus Phase 1's `List`, `Get`, `Create`, `Update`, `SetState`, `MoveAfter`, `MoveBefore`.
- Produces (the wire contract; `ui/src/api/types.ts` must match it field for field):

```go
type taskLinkDTO struct {
	Kind         string `json:"kind"` // "resource" | "worktree"
	ResourceType string `json:"resource_type,omitempty"`
	ResourceID   string `json:"resource_id,omitempty"`
	Worktree     string `json:"worktree,omitempty"`
	Focus        bool   `json:"focus"`
	Archived     bool   `json:"archived"`
}
type taskDTO struct {
	ID            int64         `json:"id"`
	Ref           string        `json:"ref"` // "T42"
	Title         string        `json:"title"`
	Description   string        `json:"description"`
	State         string        `json:"state"`
	Priority      string        `json:"priority"`
	Starred       bool          `json:"starred"`
	Due           string        `json:"due,omitempty"`
	Rank          string        `json:"rank"`
	CreatedAt     string        `json:"created_at"`
	UpdatedAt     string        `json:"updated_at"`
	StartedAt     string        `json:"started_at,omitempty"`
	CompletedAt   string        `json:"completed_at,omitempty"`
	Archived      bool          `json:"archived"`
	Links         []taskLinkDTO `json:"links"`              // never null
	Implicit      []string      `json:"implicit_worktrees"` // never null
	SubtasksTotal int           `json:"subtasks_total"`
	SubtasksDone  int           `json:"subtasks_done"`
}
```

| Method | Path | Params / body | Returns |
|---|---|---|---|
| GET | `/api/tasks` | `scope=all\|worktree\|resource`, `path` (worktree), `type`+`id` (resource), `completed=1`, `archived=1` | `[]taskDTO` in master order |
| POST | `/api/tasks` | `{title, priority?, starred?, path?, type?, id?, after?, before?}`. `path` → Focus worktree link; `type`+`id` → Focus resource link; neither → global | `taskDTO` |
| POST | `/api/tasks/update` | `{id, title?, priority?, starred?, due?}` (absent = unchanged; `due:""` clears) | `taskDTO` |
| POST | `/api/tasks/state` | `{id, state}` | `taskDTO` |
| POST | `/api/tasks/move` | `{id, after?}` or `{id, before?}`, exactly one | 204 |

Errors: `ErrInvalid` → 400, `ErrNotFound` → 404, otherwise 500. Bodies go through `http.MaxBytesReader` (64 KiB). Sort and filter happen client-side; the server only scopes.

SSE: in the same 5s tick as `events_new`, compare `tasks.Version` with the last value seen, and emit `event: tasks_changed\ndata: {}\n\n` when it has advanced. Seed it on connect, as `events_new` does.

Counts: `worktreeSummary.OpenTaskCount` (`json:"open_task_count"`) is `OpenCounts.ByWorktree[canonical(w.path)]`. Canonicalise the summary's path through `wdb.Subscriber` (CLAUDE.md gotcha). `resourceDTO.OpenTaskCount` and `allResourceDTO.OpenTaskCount` come from `ByResource[type:id]`. Call `OpenCounts` once per request.

- [ ] **Step 1: Write the failing tests** in `tasks_api_test.go`, using a server with `DB` set to a temp `wdb.OpenAt` (see how `worktree_notes_api_test.go` builds one):

```go
func TestTasksAPICreateListScopes(t *testing.T) {
	// POST /api/tasks {title:"a"} -> 200, ref "T1", links [] ; POST {title:"b", path:X} -> links[0] kind worktree focus true
	// GET ?scope=all -> 2 ; GET ?scope=worktree&path=X -> 1 ("b")
}
func TestTasksAPICreateAfter(t *testing.T) { /* after: id of "a" lands between a and the next */ }
func TestTasksAPIUpdateStateMove(t *testing.T) {
	// update {id, starred:true} -> starred ; state {id,"done"} -> completed_at set ; GET scope=all omits it, completed=1 includes it
	// move {id, before: other} -> order changes ; move with both after+before -> 400
}
func TestTasksAPIErrors(t *testing.T) { /* bad scope 400, unknown id 404, priority "urgent" 400 */ }
func TestStreamEmitsTasksChanged(t *testing.T) {
	// open /api/stream; create a task via tasks.Create directly on s.DB; within one tick (shorten the tick through the existing test seam if there is one, else run the check function directly) observe "event: tasks_changed"
}
func TestWorktreeAndResourceDTOsCarryOpenTaskCount(t *testing.T) { /* fixture as in TestOpenCounts; /api/worktrees and /api/worktree-resources carry the counts */ }
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test ./internal/webui -run 'TasksAPI|TasksChanged|OpenTaskCount'`
Expected: FAIL

- [ ] **Step 3: Implement.** Register the routes in `routes()` beside the others. Requests behind the existing auth and forgery middleware need nothing extra.

- [ ] **Step 4: Run tests**

Run: `go test ./internal/webui ./internal/tasks`
Expected: PASS

- [ ] **Step 5: Document.** Add the API table rows and a short "Tasks" section to `docs/web-ui-architecture.md`: the version-driven SSE, the counts, and that sorting is client-side.

- [ ] **Step 6: Commit** — `feat(webui): tasks API, open-task counts, and a tasks_changed stream event`

---

### Task 3: Frontend data layer

**Files:**
- Modify: `ui/src/api/types.ts` (`Task`, `TaskLink`, `open_task_count` on `WorktreeSummary`, `ResourceDTO` and `AllResourceDTO`)
- Modify: `ui/src/api/client.ts` (`api.tasks`, `api.createTask`, `api.updateTask`, `api.setTaskState`, `api.moveTask`)
- Create: `ui/src/hooks/useTasks.ts` (`useTasks(scope)`, `useTaskMutations(scope)`)
- Modify: `ui/src/hooks/useSSE.ts` (on `tasks_changed`, invalidate `["tasks"]`, `["worktrees"]`, `["resources"]`, `["all-resources"]`)
- Test: `ui/src/hooks/useTasks.test.tsx`, `ui/src/hooks/useSSE.test.tsx`

**Interfaces:**
- Consumes: Task 2's wire contract.
- Produces:

```ts
export type TaskScope =
  | { kind: "all" }
  | { kind: "worktree"; path: string }
  | { kind: "resource"; type: string; id: string }
export function taskScopeKey(s: TaskScope): unknown[] // ["tasks", ...] — the query key
export function useTasks(scope: TaskScope, opts: { completed: boolean; archived: boolean }): UseQueryResult<Task[]>
export function useTaskMutations(scope: TaskScope): {
  create(input: { title: string; priority: Priority; starred: boolean; after?: number; before?: number }): Promise<Task>
  update(id: number, patch: { title?: string; priority?: Priority; starred?: boolean; due?: string }): Promise<void>
  setState(id: number, state: TaskState): Promise<void>
  move(id: number, place: { after: number } | { before: number }, patch?: { starred?: boolean; priority?: Priority }): Promise<void>
}
```

`move` with a patch sends the update first and then the move. Both are optimistic: the cached list for the scope is reordered and patched at once, and restored if either request fails. Every mutation invalidates `["tasks"]` (all scopes), `["worktrees"]` and `["resources"]` when it settles. `create` fills in the scope's context: `path` for worktree, `type`/`id` for resource.

- [ ] **Step 1: Write the failing tests**

```ts
it("move reorders the cached list optimistically and rolls back on failure", async () => {
  // seed query cache with [A,B,C]; mock api.moveTask to reject; call move(C, {after: A.id})
  // during the request, cache order is [A,C,B]; after rejection it is [A,B,C] again
})
it("create sends the scope's context", async () => {
  // scope worktree X -> api.createTask called with path X; scope resource pr:1 -> type "pr", id "1"
})
// useSSE.test.tsx: a "tasks_changed" message invalidates ["tasks"] and ["worktrees"]
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run src/hooks/useTasks.test.tsx src/hooks/useSSE.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement**, following the client and hook patterns already in `ui/src/api/client.ts` and `ui/src/hooks/`.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd ui && npx vitest run src/hooks && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit** — `feat(ui): tasks API client, query hooks and live refresh`

---

### Task 4: Pure list logic — grouping, sorting, filtering, drop planning, due labels

**Files:**
- Create: `ui/src/lib/taskList.ts`
- Modify: `ui/src/lib/search.ts` (`matchTask`)
- Test: `ui/src/lib/taskList.test.ts`, `ui/src/lib/search.test.ts`

**Interfaces:**
- Produces:

```ts
export type TaskSort = "custom" | "priority" | "due" | "updated"
export interface TaskListPrefs { sort: TaskSort; priority: Priority | "all"; showCompleted: boolean; includeArchived: boolean }
export interface TaskSection { key: string; label: string; tasks: Task[]; draggable: boolean
  starred?: boolean; priority?: Priority }        // what dropping INTO this section implies
export function buildSections(tasks: Task[], prefs: TaskListPrefs, terms: string[]): TaskSection[]
export function canDrag(sort: TaskSort): boolean    // custom | priority
export interface DropPlan { place?: { after: number } | { before: number }; patch?: { starred?: boolean; priority?: Priority } }
export function planDrop(sections: TaskSection[], activeId: number, toSection: string, toIndex: number): DropPlan
export function dueLabel(due: string, today: Date): { text: string; tone: "overdue" | "today" | "neutral"; title: string }
export function linkChip(t: Task, ownResource?: { type: string; id: string }): { text: string; archived: boolean } | null
export function openCount(tasks: Task[]): number
```

Rules, all from Global Constraints:
- `buildSections` in Custom sort returns sections `starred` (if any), `rest`, and `completed` (when shown).
- In Priority sort, it returns `starred`, then `high`, `medium`, `low` and `none` (an empty priority section is still returned while dragging is possible, so it can take a drop), then `completed`.
- Due sort orders by due ascending, with no-due last and ties broken by rank. Updated sort orders by `updated_at` descending.
- The Completed section holds done tasks, newest `completed_at` first, with `draggable: false`.
- The priority filter and search terms apply to every section. Done tasks with `archived` appear only with `includeArchived`, because the server returns them only when `archived=1`.
- `planDrop` uses the destination section's patch: `starred: true` going into `starred`, `starred: false` leaving `starred` for another section, and `priority` for a priority section.
- `planDrop` places the task after the section's task just above `toIndex`, excluding the active task. If there is none, before the task just below. If the section has no other tasks, it uses the nearest task in the flattened visible order (after the predecessor, else before the successor). If there is no other task at all, it returns no `place`.
- `dueLabel` parses `YYYY-MM-DD` as a LOCAL date and compares whole days against `today`'s local date.

- [ ] **Step 1: Write the failing tests**, covering every rule above. Include at least:

```ts
expect(dueLabel("2026-10-21", new Date(2026, 9, 21, 23, 59)).text).toBe("Due today")
expect(dueLabel("2026-10-22", new Date(2026, 9, 21)).text).toBe("Due tomorrow")
expect(dueLabel("2026-10-24", new Date(2026, 9, 21)).text).toBe("3 days left")
expect(dueLabel("2026-10-20", new Date(2026, 9, 21))).toMatchObject({ text: "Overdue 1 day", tone: "overdue" })
expect(dueLabel("2026-11-01", new Date(2026, 9, 31)).text).toBe("Due tomorrow")
// planDrop: in Priority sort, dragging a medium task to index 0 of the empty "low" section -> patch {priority:"low"}, place relative to nearest flat neighbour
// planDrop: dragging from "rest" into "starred" at index 1 -> patch {starred:true}, place {after: starred[0].id}
// linkChip: [Focus pr, Related jira, Related wt] -> "#… +2"; all Related -> "🔗 3 linked"; own resource first Focus -> null
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run src/lib/taskList.test.ts src/lib/search.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement.** `matchTask` uses the same term rules as `matchResource` over title and description. Use `shortResourceRef` for resource chips.

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run src/lib`
Expected: PASS

- [ ] **Step 5: Commit** — `feat(ui): task list grouping, sorting, drop planning and due labels`

---

### Task 5: Accent token and the task row

**Files:**
- Modify: `ui/src/theme.ts` (`export const TASK_ACCENT = "#a3e635"`)
- Modify: `ui/src/styles/theme.css` (`--task-accent`, plus panel and badge classes `.task-panel`, `.task-count-badge`)
- Create: `ui/src/components/tasks/TaskStateCheckbox.tsx`, `ui/src/components/tasks/TaskRow.tsx`, `ui/src/components/tasks/TaskCountBadge.tsx`
- Test: `ui/src/components/tasks/TaskRow.test.tsx`

**Interfaces:**
- Consumes: `dueLabel`, `linkChip` (Task 4), `useTaskMutations` (Task 3).
- Produces:

```tsx
export function TaskStateCheckbox(props: { state: TaskState; onPick: (s: TaskState) => void }): JSX.Element
export function TaskRow(props: { task: Task; ownResource?: { type: string; id: string }; dragHandle?: ReactNode
  onState: (s: TaskState) => void; onToggleStar: () => void }): JSX.Element
export function TaskCountBadge(props: { count: number }): JSX.Element | null // null for 0
```

The checkbox is a Mantine `Menu` with three items. The in-progress fill is a 135° linear gradient, half `--task-accent` and half transparent. The star is an `ActionIcon`. The row container has `data-task-row`. A row click does nothing in this phase (the modal is Phase 3).

- [ ] **Step 1: Write the failing tests**

```tsx
it("checkbox click opens the state menu and changes nothing until a pick", async () => {
  // click checkbox -> menu shows "Not started", "In progress", "Done"; onPick not yet called; click "Not started" -> onPick("not_started")
})
it("renders due, subtask and link chips", () => { /* due overdue chip text, "2/5", link chip text */ })
it("omits the link chip on its own resource's list", () => { /* ownResource matches first Focus -> no chip */ })
it("TaskCountBadge renders nothing for zero", () => {})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run src/components/tasks`
Expected: FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run src/components/tasks && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit** — `feat(ui): task accent token, state checkbox, and the compact task row`

---

### Task 6: TaskList — toolbar, sections, drag, quick add, prefs

**Files:**
- Create: `ui/src/lib/taskListPrefs.ts` (sort, filter, show completed, include archived, **pinned**: one localStorage key `worktree.taskList`, JSON, read/write wrapped in try/catch like `unreadOnlyPref.ts`)
- Create: `ui/src/hooks/useTaskListPrefs.ts` (state backed by the above, shared across mounted lists through a `storage` event or a tiny module-level store)
- Create: `ui/src/components/tasks/TaskListToolbar.tsx`, `ui/src/components/tasks/TaskQuickAdd.tsx`, `ui/src/components/tasks/TaskList.tsx`
- Test: `ui/src/components/tasks/TaskList.test.tsx`, `ui/src/lib/taskListPrefs.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces:

```tsx
export function TaskList(props: { scope: TaskScope; ownResource?: { type: string; id: string }; maxRows?: number /* pinned: 8 */ }): JSX.Element
export function TaskListToolbar(props: { prefs: TaskListPrefs; onChange(p: Partial<TaskListPrefs>): void; pinned: boolean; onPinnedChange(v: boolean): void }): JSX.Element
export function useTaskListPrefs(): [TaskListPrefs & { pinned: boolean }, (p: Partial<TaskListPrefs & { pinned: boolean }>) => void]
```

- **Sections:** `buildSections(tasks, prefs, searchTerms)`, where the terms come from `useSearchContext()`. Each section gets a small uppercase label, shown only when there is more than one section.
- **Drag:** one `DndContext` with a `SortableContext` per draggable section, mirroring `ResourceList.tsx`'s sensors and the grip-only activator from `SortableResourceCard.tsx`. On drop, `planDrop` → `move(id, place, patch)`. When `!canDrag(sort)`, the grips render disabled, with the tooltip "Drag to reorder works in Custom or Priority order".
- **Toolbar:**
  - Sort `Select`.
  - Priority `Select` (All/High/Medium/Low/None).
  - "Show completed" `Switch`, and "Include archived" `Switch` shown only when show completed is on.
  - A Pin/Unpin `ActionIcon`.
- **Quick add:**
  - It shows only an input until it is focused or has text. Then the star toggle and priority select appear on the left and an "Add" button on the right.
  - Enter or Add calls `create({title, priority, starred, after: lastVisibleTaskId})`, clears the input and keeps focus. If nothing is visible, it omits `after` and the task goes to the bottom.
  - It is disabled while a create is in flight.
- **maxRows:** the body scrolls inside `maxRows × ~30px`.

- [ ] **Step 1: Write the failing tests**

```tsx
it("quick add reveals star and priority on focus and adds after the last visible task", async () => {})
it("Enter keeps focus for the next task", async () => {})
it("shows Include archived only with Show completed", async () => {})
it("disables drag outside custom/priority with a hint", async () => {})
it("search terms narrow the list", async () => {})
// taskListPrefs.test.ts: round-trips; storage throwing -> defaults {sort:"custom", priority:"all", showCompleted:false, includeArchived:false, pinned:false}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run src/components/tasks/TaskList.test.tsx src/lib/taskListPrefs.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run src/components/tasks src/lib && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit** — `feat(ui): task list with toolbar, starred/priority sections, drag reorder and quick add`

---

### Task 7: TasksSection (tab vs pinned) and the home page

**Files:**
- Create: `ui/src/components/tasks/TasksSection.tsx`
- Modify: `ui/src/pages/HomePage.tsx` (wide right column: Activity · Resources · Tasks; narrow tabs: Worktrees · Activity · Resources · Tasks; pinned panel above the right column's tab bar)
- Test: `ui/src/components/tasks/TasksSection.test.tsx`, `ui/src/pages/HomePage.test.tsx` (extend it if it exists, otherwise create it)

**Interfaces:**
- Consumes: `TaskList`, `useTaskListPrefs`, `useTasks`, `openCount`, `TaskCountBadge`.
- Produces a helper every placement uses, so the "tab or pinned" logic lives in one place:

```tsx
export function useTasksPlacement(scope: TaskScope, ownResource?: { type: string; id: string }): {
  pinned: boolean
  tab: ReactNode | null    // <Tabs.Tab value="tasks">Tasks <TaskCountBadge/></Tabs.Tab> when not pinned; null when pinned
  tabPanelBody: ReactNode  // <TaskList scope=…/> for the Tasks panel (unused when pinned)
  pinnedPanel: ReactNode   // the lime .task-panel with header (title "Tasks · N open", toolbar incl. Unpin) + <TaskList maxRows={8}/>; null when not pinned
  toolbar: ReactNode       // TaskListToolbar for the tab bar's right end when the Tasks tab is active
}
```

The badge on the tab shows `openCount` and is hidden while the Tasks tab is active. The HomePage's `RightTab` gains `"tasks"`. If the list becomes pinned while the Tasks tab is active, the page falls back to Activity, here and on every other page that uses the hook.

- [ ] **Step 1: Write the failing tests**

```tsx
it("not pinned: Tasks is the last tab with a lime count; its toolbar has Pin", async () => {})
it("pinning moves the list above the tab bar and removes the Tasks tab; Unpin restores it", async () => {})
it("pinning while on the Tasks tab falls back to Activity", async () => {})
it("narrow + pinned: the pinned list renders above the narrow tabs", async () => { setViewport("narrow") })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run src/components/tasks/TasksSection.test.tsx src/pages/HomePage.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit** — `feat(ui): Tasks tab and pinned task panel on the home page`

---

### Task 8: Worktree page, resource panes, Links' Details tab

**Files:**
- Modify: `ui/src/pages/WorktreeDetailPage.tsx`:
  - nothing selected, wide: a new Activity · Tasks tab bar in the right column, where today there is a bare Activity header (the activity controls move to the tab bar's right end while Activity is active)
  - nothing selected, narrow: Resources · Activity · Tasks
  - pinned: above that tab bar
- Modify: `ui/src/components/ResourceDetailPane.tsx` (PR/Jira: Activity · Linked Resources · Tasks; pinned between the resource card and the tab bar)
- Modify: `ui/src/components/SlackThreadPane.tsx` (Thread · Linked Resources · Tasks; pinned between the card and the tab bar)
- Modify: `ui/src/components/LinkPane.tsx` (new tab bar: **Details**, holding today's content, · Tasks; pinned between the card and the tab bar)
- Test: extend `ResourceDetailPane.test.tsx`, `ResourceDetailPane.slack.test.tsx`, `LinkPane.test.tsx`, and the WorktreeDetailPage tests

**Interfaces:**
- Consumes: `useTasksPlacement` (Task 7) with scope `{kind:"worktree", path}` or `{kind:"resource", type, id}` and `ownResource`.

- [ ] **Step 1: Write the failing tests**, one per placement:
  - the tab order is exactly as in Global Constraints
  - the Tasks tab is last and carries a count
  - pinning moves the list above the tab bar (on resources, below the resource card)
  - the Link pane's existing content is under "Details"
- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run src/components/ResourceDetailPane src/components/LinkPane src/pages`
Expected: FAIL

- [ ] **Step 3: Implement.** Don't change what the existing tabs contain or how their controls behave.
- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit** — `feat(ui): Tasks tab and pinned panel on the worktree page and every resource`

---

### Task 9: Badges, docs, and a real-browser check

**Files:**
- Modify: `ui/src/components/WorktreeCard.tsx` (`TaskCountBadge` for `open_task_count`, beside `UnreadBadge`)
- Modify: `ui/src/components/ResourceCard.tsx` (`TaskCountBadge` for `open_task_count`, beside `UnreadBadge`)
- Modify: `docs/web-ui-architecture.md` (Frontend structure: `components/tasks/`, `lib/taskList.ts`, the pin pref, `useTasksPlacement`)
- Modify: `docs/superpowers/specs/2026-10-21-tasks-design.md` (Phases table: Phase 2 plan path and status `done`)
- Test: extend `WorktreeCard.test.tsx` and `ResourceCard.test.tsx`

- [ ] **Step 1: Write the failing tests** — a badge with the count when `open_task_count > 0`, and none at 0.
- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run src/components/WorktreeCard.test.tsx src/components/ResourceCard.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement, and update the docs.**
- [ ] **Step 4: Full verification**

Run: `make build && go test ./... && (cd ui && npx vitest run && npx tsc --noEmit)`
Expected: all PASS. (`ui/node_modules` must be installed; run `cd ui && npm ci` first if it is missing.)

- [ ] **Step 5: Real-browser check.** Start `./bin/worktree ui --api-only` against a scratch DB copy (`WORKTREE_DB=$HOME/tmp/tasks-phase2-smoke.db`), and the Vite dev server on a free port in the worktree's range (`WORKTREE_PORTS`). Never touch Mike's running `worktree ui` or any mprocs process; capture the PIDs you start and kill only those. With Playwright, verify each of the following, then take screenshots to `$HOME/tmp/tasks-phase2-*.png`:
  - Add three tasks on home and star one.
  - Drag one into the starred group.
  - Switch to Priority sort and drag across groups.
  - Pin, check the list is above the tab bar, then unpin.
  - Add a task with the CLI (`WORKTREE_DB=… ./bin/worktree tasks add x --global`) and check it appears within about 5s with no reload.
- [ ] **Step 6: Commit** — `feat(ui): task-count badges on worktree and resource cards; document Tasks UI; mark Phase 2 done`
