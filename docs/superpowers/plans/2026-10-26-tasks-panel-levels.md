# Tasks Panel Levels and Row Menus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Tasks tab and its Pin/Unpin with one always-shown task panel that has three heights. Drop the empty-section drop strips. Add a priority menu on task rows, and draw the state menu's options as checkboxes. Stop non-searchable Selects from showing a text cursor. Record task events only for state-like changes, and delete the rest from the database.

**Architecture:** `useTasksPanel` in `components/tasks/TasksSection.tsx` replaces `useTasksPlacement`. It returns the panel, whether it is expanded, and `above(bar)`, and every page renders the panel where the pinned panel sits today. Collapsed is a global saved setting (`collapsed` in `worktree.taskList`). Expanded is component state keyed by location and scope, so it resets when you navigate away. While the panel is expanded, a page stops pinning the header that holds it, so the long list scrolls with the page.

**Tech Stack:** React 18, Mantine 7, wouter, dnd-kit, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-21-tasks-design.md`. This plan changes its "The list", "Tabs" and "Pinning" sections and the row description; Task 6 rewrites them. The design was agreed with Mike in chat on 2026-10-26, and its decisions are copied into "Global Constraints" below.

## Global Constraints

- Every page loses the Tasks tab and the Pin/Unpin button. The task panel always sits where the pinned panel sits today: above the tab bar, at the top of the home page's right column, and between the resource card and its tab bar when a resource is selected.
- **Normal level (the default):** the header shows "Tasks · N open", the unread dot and the list toolbar. The list is capped at `min(8 rows, 25dvh)` and scrolls inside itself. When the capped list overflows, a "Show all (N)" button sits directly under the list, above quick add. N is the number of tasks the list shows.
- **Collapsed level:** a top-right ActionIcon (aria-label "Collapse task list") collapses the panel to one line: "Tasks · N open", the unread dot and a chevron. The whole line is a button (aria-label "Expand task list") that returns the panel to normal. The toolbar, the list and quick add are hidden. Collapsed is ONE global saved setting.
- **Expanded level:** "Show all" removes the cap, and the button becomes "Show less". Expanded is never saved: a change of path or of the panel's scope resets it to normal. Changing a tab does not reset it.
- **Expanded and the pinned header:** while expanded, the home page's right-column header, the worktree page's activity header and the resource pane's card block stop being sticky. Everything scrolls with the page until the panel leaves expanded.
- The setting is `collapsed: boolean` (default `false`) in localStorage key `worktree.taskList`. `pinned` is removed outright. Nothing is released, so there is no migration and no back-compat.
- A URL with `?tab=tasks` falls back to the pane's first tab. `useResourceTab` already does this for an unknown tab once `"tasks"` leaves the tab lists.
- No section shows a drop strip. An empty section is not rendered at all, and an empty priority group is hidden even in Priority order. Dropping onto a non-empty section still works.
- **Priority menu:** clicking a row's priority mark opens a menu: High, Medium, Low, None. A pick saves at once through the task update.
  - Each option shows its mark: `!!!` red, `!!` amber, `!` grey, blank for None. The current option shows ✓, as the state menu does.
  - A task with no priority shows a faint `!` placeholder target. It is hidden at rest and shown at opacity 0.35 on row hover or focus-within, and always where `(hover: none)`.
- **State menu:** each option shows its checkbox drawing: empty for Not started, half-filled for In progress, and filled with ✓ for Done. The current option keeps its ✓ column.
- **Select cursor:** a non-searchable Mantine `Select` gets `caretColor: transparent` and `cursor: pointer` on its input, theme-wide. A searchable one is unchanged.
- Commits: `git commit --signoff`, files added by name, with the session trailers.

## Review Focus

- A panel that scrolls the page under a sticky header. While expanded, no sticky header may still wrap the panel; Task 3 tests that `data-activity-header` (or the pane's card block) has no `position: sticky` while expanded.
- Expanded leaking across navigation. Selecting a different resource on the worktree page, which changes scope but not path, must reset it to normal; Task 3 tests this.
- "Show all" on a short list. A list that fits must not offer Show all; Task 2 tests this with overflow mocked both ways.
- A priority pick or menu click that also opens the modal. Clicks in the portalled menu must not reach the row, as with the state menu; Task 5 tests this.
- An old `pinned` key in storage. A stored `{"pinned":true}` must parse to the defaults with `collapsed: false`; Task 1 tests this.

---

### Task 1: `collapsed` replaces `pinned` in the saved settings

**Files:**
- Modify: `ui/src/lib/taskListPrefs.ts`, `ui/src/hooks/useTaskListPrefs.ts` (doc comment only)
- Test: `ui/src/lib/taskListPrefs.test.ts` (extend the existing test, or create it if absent)

**Interfaces:**
- Produces: `StoredTaskListPrefs = TaskListPrefs & { collapsed: boolean }`, and `DEFAULT_TASK_LIST_PREFS.collapsed === false`. There is no `pinned` anywhere.

- [ ] **Step 1: Write failing tests:** `parseTaskListPrefs('{"collapsed":true}').collapsed === true`; `parseTaskListPrefs('{"collapsed":"yes"}').collapsed === false`; `parseTaskListPrefs('{"pinned":true}')` deep-equals `DEFAULT_TASK_LIST_PREFS` and has no `pinned` key.
- [ ] **Step 2: Run** `npx --prefix ui vitest run --root ui src/lib/taskListPrefs.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Rename the field and its check, and update the comments: the key holds one global "collapsed" choice.
- [ ] **Step 4: Run the test.** Expect PASS. `tsc -b ui` will fail at the old `pinned` users; Task 3 fixes those, so commit Tasks 1–3 only once tsc passes. Leave Task 1 uncommitted and commit it with Task 3.

### Task 2: TaskList's expand footer, and the toolbar without Pin

**Files:**
- Modify: `ui/src/components/tasks/TaskList.tsx`, `ui/src/components/tasks/TaskListToolbar.tsx`
- Test: `ui/src/components/tasks/TaskList.test.tsx`, plus a toolbar test if one exists

**Interfaces:**
- Produces: `TaskList({ scope, ownResource?, maxRows?, expand? })`, where `expand?: { expanded: boolean; onToggle: () => void }`. With `expand.expanded`, `maxRows` is ignored. `TaskListToolbar({ prefs, onChange })`: the `pinned`/`onPinnedChange` props and the pin icon are gone.

- [ ] **Step 1: Write failing tests:**
  - With `maxRows={8}` and `expand={{ expanded: false, onToggle }}`, and the body's `scrollHeight` mocked to exceed `clientHeight` (define both on `HTMLElement.prototype` for the test), a button named "Show all (12)" renders for 12 tasks. Clicking it calls `onToggle`.
  - With heights equal, no "Show all" button renders.
  - With `expanded: true`, a "Show less" button renders and `task-list-body` has no `max-height` style.
  - Without `expand`, neither button renders.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.**
  - Measure overflow on `task-list-body` (`scrollHeight > clientHeight + 1`) in a layout effect. Re-check it from a `ResizeObserver` (guard `typeof ResizeObserver`) and whenever the shown task count changes.
  - Place the button between the body and `TaskQuickAdd`: `Button variant="subtle" size="compact-xs"`, centred.
  - Drop `pinned`/`onPinnedChange` and the pin icon imports from the toolbar.
- [ ] **Step 4: Run the tests.** Expect PASS, apart from the toolbar's callers, which Task 3 fixes.

### Task 3: `useTasksPanel` and every page

**Files:**
- Modify: `ui/src/components/tasks/TasksSection.tsx`, `ui/src/pages/HomePage.tsx`, `ui/src/pages/WorktreeDetailPage.tsx`, `ui/src/components/ResourceDetailPane.tsx`, `ui/src/components/SlackThreadPane.tsx`, `ui/src/components/LinkPane.tsx`
- Test: `ui/src/components/tasks/TasksSection.test.tsx`, and the page and pane tests that referenced the Tasks tab or pinning (update them; grep for `TASKS_TAB`, `pinned-tasks`, `Pin task list`, `name: "Tasks"`)

**Interfaces:**
- Consumes: Task 1's `collapsed`, and Task 2's `expand` and the toolbar's props.
- Produces: `useTasksPanel(scope: TaskScope, opts?: { ownResource?: { type: string; id: string }; unread?: number }): { panel: ReactNode; expanded: boolean; above: (bar: ReactNode) => ReactNode }`. `above(bar)` is `<Stack gap="sm">{panel}{bar}</Stack>`. The panel root is `data-testid="tasks-panel"` with `data-level="collapsed" | "normal" | "expanded"`.
- Removed: `TASKS_TAB`, `tasksFallbackTab`, `useTasksPlacement`, `useResourceTasksPlacement`, `PINNED_ROWS` (keep `8` as the normal cap under a new name, e.g. `NORMAL_ROWS`), and `"tasks"` from `RightTab`/`NarrowTab` and from `DETAIL_TABS`/`THREAD_TABS`/`LINK_TABS`.

- [ ] **Step 1: Write failing tests (TasksSection.test.tsx):**
  - The default level is normal: the header has "Tasks · N open" and the toolbar's "Sort tasks".
  - Clicking "Collapse task list" gives `data-level="collapsed"`. The toolbar and quick add are gone, and the one-line "Expand task list" button shows the open count. localStorage `worktree.taskList` has `collapsed: true`. A second mounted panel is also collapsed.
  - Clicking "Expand task list" gives normal.
  - With overflow mocked, "Show all" gives `data-level="expanded"`, and nothing about expanded is written to localStorage.
  - Expanded resets to normal on a wouter navigation to another path (use a memory location hook) and when re-rendered with a different `scope`. It survives a re-render with the same scope and path.
  - With `unread: 2`, the unread dot shows in both the normal header and the collapsed line.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement `useTasksPanel`.**
  - Expanded is `useState<string | null>` holding the key `${location}|${JSON.stringify(scope)}` it was set under (location from wouter's `useLocation`). `expanded = !collapsed && expandedKey === currentKey`, so no effect is needed. Collapsing also clears it.
  - Collapsed line: an `UnstyledButton` across the panel with the count, the dot and `IconChevronDown`.
  - Normal and expanded header: the count and dot, the toolbar, and an ActionIcon with `IconChevronUp` labelled "Collapse task list".
- [ ] **Step 4: Update the pages.** Remove every Tasks tab, Tasks panel and `tasks.toolbar`-in-tab-bar branch, and render `panel` where `pinnedPanel` was, or `above(bar)` where `pinnedAbove` was.
  - HomePage: `headerStyle` also requires `!tasks.expanded`.
  - WorktreeDetailPage: the activity header's `headerStyle` also requires `!tasks.expanded`; leave `pinCards`' other uses alone.
  - ResourceDetailPane: pass the sticky style only when `stickyTop !== undefined && !tasks.expanded`.
  - SlackThreadPane: `withTasks(notice)` becomes `panel` then `notice`, with no tab bar.
  - LinkPane: its tab bar keeps only Details.
- [ ] **Step 5: Add a page test** (WorktreeDetailPage.test.tsx): with the panel expanded on the wide layout, `[data-activity-header]` has no sticky position. Selecting a resource and coming back shows `data-level="normal"`.
- [ ] **Step 6: Verify.** Run `npx --prefix ui vitest run --root ui` and `npx --prefix ui tsc -b ui`. Expect all PASS. grep `ui/src` for `pinned-tasks|TASKS_TAB|tasksFallbackTab|onPinnedChange` and expect no hits.
- [ ] **Step 7: Commit Tasks 1–3** in one commit: "feat(ui): an always-shown task panel with collapsed, normal and expanded levels".

### Task 4: No drop strips

**Files:**
- Modify: `ui/src/components/tasks/TaskList.tsx`
- Test: `ui/src/components/tasks/TaskList.test.tsx`, plus any test asserting `data-task-strip` or "Drag here" (grep)

**Interfaces:**
- Produces: `SectionBlock` renders only non-empty sections. `shown = sections.filter((s) => s.tasks.length > 0)`.

- [ ] **Step 1: Write failing tests.** With no starred task, nothing matches `/Drag here/` and nothing has `[data-task-strip]`. In Priority order with only medium tasks, there is no "High" label. Replace the old strip tests.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.** Delete `STRIP_PX`, `stripText`, the strip branch and its comments.
  - **Labelling rule:** in Priority order, label every shown group; otherwise label only when two or more sections hold tasks.
  - **Drop code:** delete any code that only handled a drop into an empty section, such as the `plan.patch`-only branch in `handleDragEnd`, but only if `dropPlanFor` can no longer return it. Check `taskDrag.ts` and its tests, and keep what non-empty drops use.
- [ ] **Step 4: Run** `npx --prefix ui vitest run --root ui src/components/tasks`. Expect PASS.
- [ ] **Step 5: Commit:** "feat(ui): drop the empty task sections' drag strips".

### Task 5: Priority menu, and checkbox drawings in the state menu

**Files:**
- Create: `ui/src/components/tasks/TaskPriorityMenu.tsx`, `ui/src/components/tasks/TaskPriorityMenu.test.tsx`
- Modify: `ui/src/components/tasks/TaskRow.tsx`, `ui/src/components/tasks/TaskStateCheckbox.tsx`, `ui/src/components/tasks/TaskList.tsx` (SortableTaskRow and the drag overlay), `ui/src/styles/theme.css`
- Test: `TaskRow.test.tsx`, `TaskStateCheckbox.test.tsx`

**Interfaces:**
- Produces:
  - **The menu:** `TaskPriorityMenu({ priority: Priority; title: string; onPick: (p: Priority) => void })`.
  - **Priority exports:** `PRIORITY_MARK` (moved from TaskRow), `PRIORITY_LABEL: Record<Priority, string>` ("High", "Medium", "Low", "None"), and the order `["high", "medium", "low", "none"]`.
  - **The target:** aria-label `Priority of “${title}”: ${label}`. With `priority === "none"` it renders `!` with class `task-priority-none`.
  - **Row prop:** `TaskRow` gets `onPriority: (p: Priority) => void`.
  - **State drawing:** `TaskStateCheckbox.tsx` exports `StateBox({ state: TaskState; size: number })`, the drawing the target already uses, reused in the menu at size 12.

- [ ] **Step 1: Write failing tests:**
  - Clicking `Priority of “t”: None` opens a menu whose items read High, Medium, Low and None. Each item except None contains its mark text. The None item has `aria-current="true"`.
  - Picking High calls `onPick("high")`, and the row's `onOpen` is not called (render inside a TaskRow with an `onOpen` spy).
  - In TaskList, picking a priority calls the update mutation with `{ priority }`.
  - State menu: each item contains a `[data-state-box]` element whose `data-state` equals its state.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.**
  - Mirror TaskStateCheckbox: a `Menu` with `withinPortal`, `stopPropagation` on the target and on `Menu.Dropdown`, and `aria-current` with a ✓ `leftSection` column, with the mark shown after it in a 22px slot.
  - Keep the row's 22px slot so titles stay aligned.
  - CSS in `styles/theme.css`: `.task-priority-none { opacity: 0 }`; `[data-task-row]:hover .task-priority-none, [data-task-row]:focus-within .task-priority-none { opacity: .35 }`; and inside the existing `@media (hover: none)` block, `.task-priority-none { opacity: .35 }`.
  - The drag overlay row passes a no-op `onPriority`.
- [ ] **Step 4: Run** `npx --prefix ui vitest run --root ui src/components/tasks`. Expect PASS.
- [ ] **Step 5: Commit:** "feat(ui): priority menu on task rows; state menu shows each checkbox".

### Task 6: Only state-like changes are task events

Mike, 2026-10-26: task edits no longer count as activity events. These stay, as activity and as events: `task_created`, `task_state_changed`, `task_deleted`, `task_blocker_resolved`, `task_blocker_unresolved`, `subtask_checked` and `subtask_unchecked`. Every other type stops being recorded, and its existing rows are deleted: `task_edited`, `task_linked`, `task_unlinked`, `task_focus_changed`, `subtask_added`, `subtask_edited`, `subtask_removed`, `task_event_linked`, `task_event_unlinked`, `task_blocker_added` and `task_blocker_removed`. The edits themselves still save and still bump `updated_at`; only their event rows go. Undo and the Unblocked notification read only kept types, so neither changes.

**Files:**
- Modify: `internal/tasks/events.go` (drop the constants), `internal/tasks/tasks.go`, `internal/tasks/links.go`, `internal/tasks/subtasks.go`, `internal/tasks/eventlinks.go`, `internal/tasks/blockers.go` (drop those `record` calls), `internal/db/migrate.go`, `internal/webui/task_timeline.go` (drop their titles and labels), `ui/src/lib/eventMeta.tsx` (drop their entries)
- Test: `internal/tasks/*_test.go`, `internal/db/db_test.go`, `internal/webui/*_test.go` and UI tests that expect the dropped types (grep each type name)

**Interfaces:**
- Produces: `tasks.Events` and every feed, unread and notification query see only the kept types. Callers of the edit functions (`Update`, link, subtask and blocker writers) keep their signatures and return values; only the event write goes.

- [ ] **Step 1: Write failing tests.** In `internal/tasks`, after a task is created, edited (title), linked, refocused, has a subtask added, edited and removed, has an event linked and unlinked, and has a blocker added and removed, `Events(conn, id)` lists only `task_created`. In `internal/db`, a DB holding one row of each dropped type and one `task_state_changed` row keeps only the `task_state_changed` row after `migrate`, and a second `migrate` changes nothing.
- [ ] **Step 2: Run** `go test ./internal/tasks/ ./internal/db/`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - Remove the dropped `record` calls along with any payload helpers left unused (e.g. `linkPayload`, `eventLinkPayload`, `subtaskPayload` if nothing else uses them). Keep each transaction's other writes as they are.
  - In `migrate`, after the task tables are created, add `DELETE FROM task_events WHERE type IN (…the eleven dropped types…)` with a comment. Like the backfill beside it, it reruns on every start, and once the rows are gone it deletes nothing, since nothing writes those types any more.
  - Drop the types' entries in `task_timeline.go` and `eventMeta.tsx`.
- [ ] **Step 4: Fix the tests that asserted dropped events.** Delete assertions that only checked a dropped event. Keep any assertion about the edit's effect on the task.
- [ ] **Step 5: Run** `go test ./...` and `npx --prefix ui vitest run --root ui`. Expect PASS.
- [ ] **Step 6: Commit:** "feat(tasks): only state changes, create, delete, blocker resolution and subtask checks are task events".

### Task 7: No text cursor in non-searchable Selects, and docs

**Files:**
- Modify: `ui/src/theme.ts`, `docs/superpowers/specs/2026-10-21-tasks-design.md`, `docs/web-ui-architecture.md`
- Test: `ui/src/theme.test.tsx` (create it if absent)

**Interfaces:**
- Produces: in theme `components`, `Select: Select.extend({ styles: (_theme, props) => (props.searchable ? {} : { input: { caretColor: "transparent", cursor: "pointer" } }) })`.

- [ ] **Step 1: Write a failing test.** Render `<Select aria-label="s" data={["a"]} />` inside `MantineProvider theme={theme}`, and expect the input `toHaveStyle({ caretColor: "transparent" })`. The same with `searchable` must not have it.
- [ ] **Step 2: Run it.** Expect FAIL. Then implement it and run again. Expect PASS.
- [ ] **Step 3: Update the docs.**
  - **Task events:** in the spec and the architecture doc, wherever task event types, the task history or what counts as task activity are listed, list only the kept types (Task 6) and say that edits record no event.
  - **The spec:** rewrite "Tabs" (no Tasks tab; Tasks is the panel), "Pinning" (rename to "The task panel": the three levels, the global `collapsed` setting, expanded never saved, and headers unsticking while expanded), "The list" (the toolbar has no Pin, and there are no drop strips) and the row description (the priority mark is a menu, with the None placeholder).
  - **The architecture doc:** update the passages around lines 844, 1284–1323, 1360–1364 and 1981, plus any other mention of `useTasksPlacement`, `pinnedPanel`, `pinnedAbove`, Tasks tabs or drop strips, to describe `useTasksPanel`. Mention the Select theme rule wherever the theme's component defaults are described.
- [ ] **Step 4: Run the full verification.** Expect each of these to pass: `npx --prefix ui vitest run --root ui`, `npx --prefix ui tsc -b ui`, `go test ./...`, `make build`, and `git status --short` showing only intended files.
- [ ] **Step 5: Commit:** "fix(ui): no text cursor in non-searchable selects; docs for the task panel".
