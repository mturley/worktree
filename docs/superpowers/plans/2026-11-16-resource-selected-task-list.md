# Worktree Task List While a Resource Is Selected: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the worktree's whole task list visible and in place when a resource is selected, mark the selected resource's tasks (violet bar + tint + "this PR" tag), link quick-added tasks to the selected resource with a hint saying so, and show priority icons in the quick-add priority dropdown.

**Architecture:** The worktree page's existing `useTasksPanel` (worktree scope) learns a `selectedResource`. It passes that to `TaskList`, which uses it to mark rows (`TaskRow`) and as the scope new tasks are created in (the list's query stays worktree-scoped). The page renders the panel at the head of its content column in both states. The resource panes drop their own panels, and `OtherTasksBadge` is deleted.

**Tech Stack:** React 18 + Mantine 7, TanStack Query, Vitest + Testing Library (`cd ui && npm test`).

**Spec:** `docs/superpowers/specs/2026-11-16-resource-selected-task-list-design.md`

## Global Constraints

- Blue means unread. The "this resource" marking never uses blue: it uses violet, as the selected ResourceCard does (`var(--mantine-color-violet-filled)` for the bar, `var(--mantine-color-violet-light)` for the tint, Mantine `color="violet"` for the tag).
- Nothing fades, and nothing shifts layout on select/deselect (no gutter columns that appear only with a selection).
- Tag wording comes from `scopeContext` (`components/tasks/TasksSection.tsx`): "this PR" / "this issue" / "this thread" / "this link" / "this resource" (Mantine Badge renders it uppercase).
- Quick-add copy: placeholder `Add a task to <target>…`; tooltip on Add `Add to <target>`, on Add & open `Add to <target> and open it`. `<target>` is `scopeContext` of the scope the task is created in. Scope `all` (home) gets no target: today's placeholder `Add a task…` and no tooltips.
- Per repo memory: do not add tests or comments asserting removed things are gone (the badge, the pane panels). Delete their tests with them.
- Commits: `git commit --signoff`, add files by name.

## Review Focus

1. **A task linked to the selected resource by a non-focus link:** marked (bar, tint, tag), and its chip still names its focus resource. Tested in Task 3.
2. **An unread task of the selected resource:** keeps the blue unread border and background (no violet tint), but still gets the violet bar and the tag. Tested in Task 3.
3. **Quick-add while selected, for a resource the worktree follows:** the task is created with the resource's `type`/`id` (not `path`), and shows up in the worktree list after refetch. Tested in Task 4 (create args). The list membership relies on the server's `implicit_worktrees`, already covered server-side.
4. **Expanded panel across select/deselect:** stays expanded; selecting must not remount the panel. Tested in Task 5.
5. **Narrow layout with a selection:** the panel is shown above the drilled-down resource pane, not hidden. Tested in Task 5.

---

### Task 1: Priority icons in the quick-add priority dropdown

**Files:**
- Create: `ui/src/components/tasks/iconOption.tsx`
- Modify: `ui/src/components/tasks/modal/TaskSidebar.tsx` (drop its local `option`, import the shared one)
- Modify: `ui/src/components/tasks/TaskQuickAdd.tsx:95-106`
- Test: `ui/src/components/tasks/TaskQuickAdd.test.tsx`

**Interfaces:**
- Produces: `export function iconOption(icon: ReactNode, label: string): ReactNode`, the body moved verbatim from `TaskSidebar`'s `option`.

- [ ] **Step 1: Write the failing test** in `TaskQuickAdd.test.tsx`:

```tsx
describe("TaskQuickAdd priority", () => {
  it("shows each priority's glyph in the options and beside the chosen value", async () => {
    render(<MantineProvider><TaskQuickAdd onAdd={vi.fn().mockResolvedValue(undefined)} /></MantineProvider>)
    act(() => screen.getByRole("textbox", { name: "New task" }).focus())
    const select = screen.getByRole("textbox", { name: "New task priority" })
    fireEvent.click(select)
    expect(await screen.findByRole("option", { name: /High/ })).toHaveTextContent("!!!")
    expect(screen.getByRole("option", { name: /Medium/ })).toHaveTextContent("!!")
    fireEvent.click(screen.getByRole("option", { name: /High/ }))
    // The chosen value's glyph sits in the input's left section.
    expect(select.closest(".mantine-Select-root, .mantine-InputWrapper-root")!).toHaveTextContent("!!!")
  })
})
```

(If the Select's accessible role differs in this Mantine version, find it the way the existing tests reach "New task priority". The assertions stay the same.)

- [ ] **Step 2: Run it and confirm it fails.** `cd ui && npx vitest run src/components/tasks/TaskQuickAdd.test.tsx`. Expected: FAIL, no "!!!" in the option.

- [ ] **Step 3: Implement.** Create `iconOption.tsx`, then use it in `TaskSidebar`. In `TaskQuickAdd`'s Select add `leftSection={<PriorityGlyph priority={priority} />}` and `renderOption={({ option: o }) => iconOption(<PriorityGlyph priority={o.value as Priority} />, o.label)}`, importing `PriorityGlyph` from `./TaskPriorityMenu`. Widen `w={95}` to whatever fits "Medium" plus the glyph without truncating (about 115).

- [ ] **Step 4: Run the tests.** `cd ui && npx vitest run src/components/tasks/`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add ui/src/components/tasks/iconOption.tsx ui/src/components/tasks/modal/TaskSidebar.tsx ui/src/components/tasks/TaskQuickAdd.tsx ui/src/components/tasks/TaskQuickAdd.test.tsx
git commit --signoff -m "feat(ui): priority icons in the quick-add priority dropdown"
```

### Task 2: List helpers: does a task link a resource, and the chip for it

**Files:**
- Modify: `ui/src/lib/taskSections.ts` (`linkChip` at ~369, new `linksResource`)
- Test: `ui/src/lib/taskSections.test.ts` (`describe("linkChip")` at ~526)

**Interfaces:**
- Produces: `export function linksResource(t: Task, r: ResourceKey): boolean`. True when any `kind === "resource"` link has `resource_type === r.type && resource_id === r.id` (focus or not, archived or not).
- Changes: `linkChip(t, ownResource?, ownWorktree?)` keeps its signature. When the first focus link IS `ownResource`, it returns `null` only if that is the task's only link. Otherwise it returns `{ text: "+N", archived: false }` with N = other links, and no `worktree`/`target`.

- [ ] **Step 1: Write the failing tests.** Replace the `"is null on the list of the resource its first Focus link names"` case's first expectation and add:

```ts
it("on its own resource's list: null alone, just the count of the others otherwise", () => {
  const own = { type: "pr", id: "opendatahub-io/odh-dashboard#4521" }
  expect(linkChip(withLinks([pr(true)]), own)).toBeNull()
  expect(linkChip(withLinks([pr(true), jira(false)]), own)).toEqual({ text: "+1", archived: false })
  expect(linkChip(withLinks([jira(true), pr(true)]), own)).toEqual({ text: "RHOAIENG-1 +1", archived: false })
})

describe("linksResource", () => {
  const r = { type: "pr", id: "o/r#1" }
  const link = (over: Partial<TaskLink>): TaskLink => ({ kind: "resource", resource_type: "pr", resource_id: "o/r#1", focus: false, archived: false, ...over })
  it("matches any link to the resource, focus or not, archived or not", () => {
    expect(linksResource(mk(1, "a", { links: [link({})] }), r)).toBe(true)
    expect(linksResource(mk(1, "a", { links: [link({ focus: true, archived: true })] }), r)).toBe(true)
  })
  it("does not match another resource, another type, or a worktree link", () => {
    expect(linksResource(mk(1, "a", { links: [link({ resource_id: "o/r#2" })] }), r)).toBe(false)
    expect(linksResource(mk(1, "a", { links: [link({ resource_type: "jira" })] }), r)).toBe(false)
    expect(linksResource(mk(1, "a", { links: [{ kind: "worktree", worktree: "/w", focus: true, archived: false }] }), r)).toBe(false)
  })
})
```

- [ ] **Step 2: Run them and confirm they fail.** `cd ui && npx vitest run src/lib/taskSections.test.ts`. Expected: FAIL (`+1` case returns null; `linksResource` is not exported).

- [ ] **Step 3: Implement** both in `taskSections.ts`.

- [ ] **Step 4: Run them and confirm they pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add ui/src/lib/taskSections.ts ui/src/lib/taskSections.test.ts
git commit --signoff -m "feat(ui): linksResource helper; own-resource chip keeps the other links' count"
```

### Task 3: TaskRow marks the selected resource's tasks

**Files:**
- Modify: `ui/src/components/tasks/TaskRow.tsx` (props at ~55, row `style` at ~138-149, chip area at ~224)
- Modify: `ui/src/styles/theme.css` (next to the `.task-panel` rules, ~103)
- Test: `ui/src/components/tasks/TaskRow.test.tsx`

**Interfaces:**
- Consumes: `linksResource`, `linkChip` (Task 2); `scopeContext` (`TasksSection.tsx`).
- Produces: `TaskRow` prop `ownResource` is renamed `selectedResource?: ResourceKey` (same meaning for the chip, plus marking). A marked row carries `data-selected-resource="true"` on its `[data-task-row]` element, and the tag is `data-testid="task-this-resource-tag"`.

- [ ] **Step 1: Write the failing tests** in `TaskRow.test.tsx`:

```tsx
describe("TaskRow selected resource", () => {
  const sel = { type: "pr", id: "o/r#1" }
  const prLink = (focus: boolean) => ({ kind: "resource" as const, resource_type: "pr", resource_id: "o/r#1", focus, archived: false })
  const jiraLink = { kind: "resource" as const, resource_type: "jira", resource_id: "J-1", focus: true, archived: false }
  const noop = { onState: () => {}, onPriority: () => {}, onToggleStar: () => {} }
  const row = () => document.querySelector<HTMLElement>("[data-task-row]")!

  it("marks a task linking the resource with the violet tint and a 'this PR' tag in place of its chip", () => {
    wrap(<TaskRow task={task({ links: [prLink(true)] })} selectedResource={sel} {...noop} />)
    expect(row()).toHaveAttribute("data-selected-resource", "true")
    expect(row().style.background).toContain("violet-light")
    expect(screen.getByTestId("task-this-resource-tag")).toHaveTextContent(/this PR/i)
    expect(screen.queryByTestId("task-link-chip")).toBeNull()
  })

  it("a non-focus link still marks it, and the focus resource's chip stays", () => {
    wrap(<TaskRow task={task({ links: [jiraLink, prLink(false)] })} selectedResource={sel} {...noop} />)
    expect(row()).toHaveAttribute("data-selected-resource", "true")
    expect(screen.getByTestId("task-link-chip")).toHaveTextContent("J-1 +1")
  })

  it("an unread marked row keeps the blue unread background, with the tag", () => {
    wrap(<TaskRow task={task({ links: [prLink(true)], unread_count: 2 })} selectedResource={sel} {...noop} />)
    expect(row().style.background).toContain("blue")
    expect(row()).toHaveAttribute("data-selected-resource", "true")
    expect(screen.getByTestId("task-this-resource-tag")).toBeInTheDocument()
  })

  it("leaves other tasks, and every task with no selection, unmarked", () => {
    wrap(<><TaskRow task={task({ links: [jiraLink] })} selectedResource={sel} {...noop} /><TaskRow task={task({ links: [prLink(true)] })} {...noop} /></>)
    expect(document.querySelectorAll("[data-selected-resource]")).toHaveLength(0)
    expect(screen.queryByTestId("task-this-resource-tag")).toBeNull()
  })
})
```

- [ ] **Step 2: Run them and confirm they fail.** `cd ui && npx vitest run src/components/tasks/TaskRow.test.tsx`. Expected: FAIL, unknown prop and no marking.

- [ ] **Step 3: Implement.**
  - Rename the prop, and compute `const marked = selectedResource ? linksResource(task, selectedResource) : false`.
  - On the row `Group`: `data-selected-resource={marked ? "true" : undefined}`, add `position: "relative"` to the style, and set `background` to `UNREAD_BG` if unread, else `var(--mantine-color-violet-light)` if marked.
  - Before the link chip, when marked, render `<Badge data-testid="task-this-resource-tag" size="xs" variant="outline" color="violet" style={{ flex: "none" }}>{scopeContext({ kind: "resource", ...selectedResource })}</Badge>`.
  - The bar goes in `theme.css`: `[data-task-row][data-selected-resource]::before { content: ""; position: absolute; left: -9px; top: 3px; bottom: 3px; width: 3px; border-radius: 2px; background: var(--mantine-color-violet-filled); pointer-events: none; }`. Tune `left` in the browser so the bar sits centred in the panel's left padding, outside the row's 2px unread border and clear of the panel's lime edge.
  - Update `TaskList.tsx`'s two `TaskRow` call sites (~184 and ~472) to pass `selectedResource={ownResource}` for now. Task 4 renames the `TaskList` side.

- [ ] **Step 4: Run them and confirm they pass.** `cd ui && npx vitest run src/components/tasks/`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add ui/src/components/tasks/TaskRow.tsx ui/src/components/tasks/TaskRow.test.tsx ui/src/components/tasks/TaskList.tsx ui/src/styles/theme.css
git commit --signoff -m "feat(ui): mark the selected resource's tasks with a violet bar, tint and tag"
```

### Task 4: TaskList and quick-add create in the selected resource, and say so

**Files:**
- Modify: `ui/src/components/tasks/TaskList.tsx` (props ~286, `useTaskMutations` ~302, `add` ~399, `<TaskQuickAdd>` ~503)
- Modify: `ui/src/components/tasks/TaskQuickAdd.tsx`
- Modify: `ui/src/components/tasks/TasksSection.tsx` (`useTasksPanel` options)
- Test: `ui/src/components/tasks/TaskQuickAdd.test.tsx`, `ui/src/components/tasks/TaskList.test.tsx`

**Interfaces:**
- Consumes: `TaskRow`'s `selectedResource` (Task 3).
- Produces:
  - `TaskList({ scope, selectedResource?: ResourceKey, maxRows?, expand? })`. `ownResource` is removed. New tasks are created in `selectedResource ? { kind: "resource", ...selectedResource } : scope`, through a second `useTaskMutations(addScope)` used only for `create`. Every other mutation keeps `scope`.
  - `TaskQuickAdd({ onAdd, onOpen?, target?: string })`.
  - `useTasksPanel(scope, opts?: { selectedResource?: ResourceKey; unread?: number })`. `ownResource` and `resetKey` are removed, and the doc comment about them is updated. The panel title keeps `Tasks (<scopeContext(scope)>)`, so it reads "Tasks (this worktree)" with or without a selection.

- [ ] **Step 1: Write the failing tests.** In `TaskQuickAdd.test.tsx`:

```tsx
it("names where the task goes: placeholder, and tooltips on Add and Add & open", async () => {
  render(<MantineProvider><TaskQuickAdd onAdd={vi.fn().mockResolvedValue(undefined)} onOpen={vi.fn()} target="this PR" /></MantineProvider>)
  const input = screen.getByRole("textbox", { name: "New task" })
  expect(input).toHaveAttribute("placeholder", "Add a task to this PR…")
  act(() => input.focus())
  fireEvent.change(input, { target: { value: "x" } })
  fireEvent.mouseEnter(screen.getByRole("button", { name: "Add" }))
  expect(await screen.findByText("Add to this PR")).toBeInTheDocument()
  fireEvent.mouseEnter(screen.getByRole("button", { name: "Add & open" }))
  expect(await screen.findByText("Add to this PR and open it")).toBeInTheDocument()
})

it("without a target keeps the plain placeholder", () => {
  render(<MantineProvider><TaskQuickAdd onAdd={vi.fn().mockResolvedValue(undefined)} /></MantineProvider>)
  expect(screen.getByRole("textbox", { name: "New task" })).toHaveAttribute("placeholder", "Add a task…")
})
```

In `TaskList.test.tsx`, using its existing `wrap` and `api` mocks:

```tsx
it("with a selected resource, lists the worktree's tasks but creates new ones in the resource", async () => {
  vi.spyOn(api, "tasks").mockResolvedValue([])
  const create = vi.spyOn(api, "createTask").mockResolvedValue({ id: 9 } as never)
  wrap(<TaskList scope={{ kind: "worktree", path: "/wt" }} selectedResource={{ type: "pr", id: "o/r#1" }} />)
  expect(api.tasks).toHaveBeenCalledWith({ kind: "worktree", path: "/wt" }, expect.anything())
  const input = screen.getByRole("textbox", { name: "New task" })
  expect(input).toHaveAttribute("placeholder", "Add a task to this PR…")
  await userEvent.type(input, "Chase review{Enter}")
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: "Chase review", type: "pr", id: "o/r#1" })))
  expect(create.mock.calls[0][0]).not.toHaveProperty("path")
})

it("without a selection creates in the list's own scope", async () => {
  vi.spyOn(api, "tasks").mockResolvedValue([])
  const create = vi.spyOn(api, "createTask").mockResolvedValue({ id: 9 } as never)
  wrap(<TaskList scope={{ kind: "worktree", path: "/wt" }} />)
  expect(screen.getByRole("textbox", { name: "New task" })).toHaveAttribute("placeholder", "Add a task to this worktree…")
  await userEvent.type(screen.getByRole("textbox", { name: "New task" }), "Tidy{Enter}")
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ path: "/wt" })))
})
```

- [ ] **Step 2: Run them and confirm they fail.** `cd ui && npx vitest run src/components/tasks/`. Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block. `TaskList` computes `target = addScope.kind === "all" ? undefined : scopeContext(addScope)`. In `TaskQuickAdd`, wrap each button in a Mantine `Tooltip` only when `target` is set. Fix every existing caller of `ownResource` (`TasksSection.tsx`, and the resource panes until Task 5 removes their panels) so that `npx tsc -b` passes.

- [ ] **Step 4: Run them and confirm they pass.** `cd ui && npx vitest run src/components/tasks/ && npx tsc -b`. Expected: PASS, no type errors.

- [ ] **Step 5: Commit.**

```bash
git add ui/src/components/tasks/TaskList.tsx ui/src/components/tasks/TaskList.test.tsx ui/src/components/tasks/TaskQuickAdd.tsx ui/src/components/tasks/TaskQuickAdd.test.tsx ui/src/components/tasks/TasksSection.tsx
git commit --signoff -m "feat(ui): quick-add creates in the selected resource and names its target"
```

(Add any pane files touched for the rename to the `git add`.)

### Task 5: The worktree page keeps its panel through a selection

**Files:**
- Modify: `ui/src/pages/WorktreeDetailPage.tsx` (~299-307 hook, ~580-590 narrow, ~660-670 wide)
- Modify: `ui/src/components/ResourceDetailPane.tsx` (remove `useTasksPanel` ~105-108 and `{tasks.panel}` ~143, `OtherTasksBadge` ~292-301; update comments that mention the task panel)
- Modify: `ui/src/components/SlackThreadPane.tsx` (remove `useTasksPanel` ~83-87 and both `{tasks.panel}` ~109, ~167)
- Modify: `ui/src/components/LinkPane.tsx` (remove `useTasksPanel` ~41 and `{tasks.panel}` ~48)
- Delete: `ui/src/components/tasks/OtherTasksBadge.tsx`, `ui/src/components/tasks/OtherTasksBadge.test.tsx` (`git rm`)
- Test: `ui/src/pages/WorktreeDetailPage.test.tsx` (`describe` block at ~1480-1560); delete the pane-panel and badge tests in `ResourceDetailPane.test.tsx` (~382-445) and `LinkPane.test.tsx` (~129)

**Interfaces:**
- Consumes: `useTasksPanel(scope, { selectedResource })` (Task 4).

- [ ] **Step 1: Write the failing tests** in `WorktreeDetailPage.test.tsx`. Replace the last two tests of the task-panel block (`"wide: the activity header stays pinned…a selection and back resets expanded"` keeps its first half; `"a selected resource's pane shows that resource's tasks…"` is replaced):

```tsx
it("wide: an expanded panel stays expanded, and in place, through a selection and back", async () => {
  setViewport("wide")
  mockOverflow()
  const user = userEvent.setup()
  wrap()
  const panel = screen.getByTestId("tasks-panel")
  await user.click(await within(panel).findByRole("button", { name: /^Show all \(/ }))
  await user.click(screen.getByRole("button", { name: /select resource o\/r#1/i }))
  await screen.findByRole("tab", { name: /Linked Resources/ })
  // The same element: never remounted by the selection.
  expect(screen.getByTestId("tasks-panel")).toBe(panel)
  expect(panel).toHaveAttribute("data-level", "expanded")
  const back = screen.getByRole("button", { name: /^← all resources/ })
  expect(panel.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await user.click(back)
  await waitFor(() => expect(document.querySelector("[data-activity-header]")).not.toBeNull())
  expect(screen.getByTestId("tasks-panel")).toBe(panel)
  expect(panel).toHaveAttribute("data-level", "expanded")
})

it("a selected resource keeps the worktree's list, marking that resource's tasks", async () => {
  vi.mocked(api.tasks).mockResolvedValue([
    { ...task, id: 2, title: "Chase the reviewer", links: [{ kind: "resource", resource_type: "pr", resource_id: "o/r#1", focus: true, archived: false }] },
    task,
  ])
  window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
  setViewport("wide")
  wrap()
  await screen.findByRole("tab", { name: /Linked Resources/ })
  const panel = screen.getByTestId("tasks-panel")
  expect(await within(panel).findByText("Tidy the branch")).toBeInTheDocument()
  const marked = within(panel).getByText("Chase the reviewer").closest("[data-task-row]")!
  expect(marked).toHaveAttribute("data-selected-resource", "true")
  expect(api.tasks).not.toHaveBeenCalledWith({ kind: "resource", type: "pr", id: "o/r#1" }, expect.anything())
})

it("narrow: the panel heads a selected resource's drill-down", async () => {
  window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
  setViewport("narrow")
  wrap()
  const back = await screen.findByRole("button", { name: /^← all resources/ })
  const panel = screen.getByTestId("tasks-panel")
  expect(await within(panel).findByText("Tidy the branch")).toBeInTheDocument()
  expect(panel.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
```

(Use the block's existing `task` fixture and mocks; adjust the fixture spread if its shape differs.)

- [ ] **Step 2: Run them and confirm they fail.** `cd ui && npx vitest run src/pages/WorktreeDetailPage.test.tsx -t "panel|selected resource"`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Hook: `useTasksPanel(taskScope, { selectedResource: selected ?? undefined })`. Update the comment above it.
  - Wide right column: `<Stack gap={detail ? "sm" : headerStyle ? "md" : "sm"}>{tasks.panel}{detail || unfiltered(rightTabBar)}</Stack>`. The panel is always the Stack's first child, so it never remounts. Keep the existing comment's reasoning about the md gap for the pinned activity header.
  - Narrow: `<Stack gap="sm">{tasks.panel}{detail || <Tabs …/>}</Stack>`, with the panel first for the same reason.
  - Remove the panes' panels and the badge as listed under Files, along with their now-unused imports. Delete the badge and pane-panel tests (don't add tests asserting their absence).

- [ ] **Step 4: Run the whole UI suite and the type check.** `cd ui && npm test && npx tsc -b`. Expected: all PASS.

- [ ] **Step 5: Check it by eye.** `make build`, open a worktree in `worktree ui`, select and deselect a PR with tasks. The list stays put, the bar sits outside the blue unread border in the panel's padding, the tag reads THIS PR, and adding a task shows "Add a task to this PR…". Tune the bar's `left` in `theme.css` if needed.

- [ ] **Step 6: Commit.**

```bash
git rm ui/src/components/tasks/OtherTasksBadge.tsx ui/src/components/tasks/OtherTasksBadge.test.tsx
git add ui/src/pages/WorktreeDetailPage.tsx ui/src/pages/WorktreeDetailPage.test.tsx ui/src/components/ResourceDetailPane.tsx ui/src/components/ResourceDetailPane.test.tsx ui/src/components/SlackThreadPane.tsx ui/src/components/LinkPane.tsx ui/src/components/LinkPane.test.tsx ui/src/styles/theme.css
git commit --signoff -m "feat(ui): keep the worktree's task list in place while a resource is selected"
```

- [ ] **Step 7: Docs.** If `docs/web-ui-architecture.md` describes the resource pane's task panel or the other-tasks badge, update that passage to the new behavior (describe what is, not what was removed), and commit it with `docs:`.
