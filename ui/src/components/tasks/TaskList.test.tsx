import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { Task } from "../../api/types"
import { SearchContext } from "../search/SearchContext"
import { TASK_LIST_KEY } from "../../lib/taskListPrefs"
import { buildSections } from "../../lib/taskSections"
import { useTaskListPrefs } from "../../hooks/useTaskListPrefs"
import { TaskList } from "./TaskList"
import { TaskListToolbar } from "./TaskListToolbar"
import { dropPlanFor, sectionDroppableId, taskDraggableId } from "./taskDrag"

vi.mock("../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../api/client")>()),
  api: {
    tasks: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    setTaskState: vi.fn(),
    moveTask: vi.fn(),
  },
}))

const task = (id: number, extra: Partial<Task> = {}): Task => ({
  id, ref: `T${id}`, title: `task ${id}`, description: "", state: "not_started", priority: "none", starred: false,
  rank: `r${id}`, created_at: "", updated_at: "", archived: false, links: [], implicit_worktrees: [],
  subtasks_total: 0, subtasks_done: 0, ...extra,
})

function wrap(ui: React.ReactNode, terms: string[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <SearchContext.Provider value={{ terms }}>{ui}</SearchContext.Provider>
      </QueryClientProvider>
    </MantineProvider>,
  )
}

const setPrefs = (p: object) => window.localStorage.setItem(TASK_LIST_KEY, JSON.stringify(p))

beforeEach(() => {
  vi.mocked(api.tasks).mockResolvedValue([task(1, { title: "alpha one" }), task(2, { title: "beta two" })])
  vi.mocked(api.createTask).mockResolvedValue(task(9))
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.localStorage.clear()
})

describe("TaskList quick add", () => {
  it("quick add reveals star and priority on focus and adds after the last visible task", async () => {
    const user = userEvent.setup()
    wrap(<TaskList scope={{ kind: "worktree", path: "/w" }} />)
    await screen.findByText("beta two")
    const input = screen.getByRole("textbox", { name: "New task" })
    expect(screen.queryByRole("button", { name: "Star new task" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull()

    await user.click(input)
    expect(screen.getByRole("button", { name: "Star new task" })).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "New task priority" })).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Star new task" }))
    await user.type(input, "gamma")
    await user.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(api.createTask).toHaveBeenCalled())
    expect(api.createTask).toHaveBeenCalledWith({
      title: "gamma", priority: "none", starred: true, after: 2, path: "/w",
    })
  })

  it("omits after when nothing is visible", async () => {
    vi.mocked(api.tasks).mockResolvedValue([])
    const user = userEvent.setup()
    wrap(<TaskList scope={{ kind: "all" }} />)
    const input = screen.getByRole("textbox", { name: "New task" })
    await waitFor(() => expect(api.tasks).toHaveBeenCalled())
    await user.type(input, "first{Enter}")
    await waitFor(() => expect(api.createTask).toHaveBeenCalled())
    expect(api.createTask).toHaveBeenCalledWith({ title: "first", priority: "none", starred: false })
  })

  it("Enter keeps focus for the next task", async () => {
    const user = userEvent.setup()
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    const input = screen.getByRole("textbox", { name: "New task" })
    await user.type(input, "next{Enter}")
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(input).toHaveValue(""))
    expect(input).toHaveFocus()
    expect(input).not.toBeDisabled()
  })
})

function ToolbarHarness() {
  const [prefs, set] = useTaskListPrefs()
  return <TaskListToolbar prefs={prefs} onChange={set} pinned={prefs.pinned} onPinnedChange={(v) => set({ pinned: v })} />
}

describe("TaskListToolbar", () => {
  it("shows Include archived only with Show completed", async () => {
    const user = userEvent.setup()
    wrap(<ToolbarHarness />)
    expect(screen.queryByRole("switch", { name: "Include archived" })).toBeNull()
    await user.click(screen.getByRole("switch", { name: "Show completed" }))
    expect(screen.getByRole("switch", { name: "Include archived" })).toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem(TASK_LIST_KEY)!).showCompleted).toBe(true)
  })

  it("pins and unpins", async () => {
    const user = userEvent.setup()
    wrap(<ToolbarHarness />)
    await user.click(screen.getByRole("button", { name: "Pin task list" }))
    expect(screen.getByRole("button", { name: "Unpin task list" })).toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem(TASK_LIST_KEY)!).pinned).toBe(true)
  })
})

describe("TaskList", () => {
  it("disables drag outside custom/priority with a hint", async () => {
    setPrefs({ sort: "due" })
    const user = userEvent.setup()
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    const grip = screen.getByRole("button", { name: "Drag to reorder alpha one" })
    expect(grip).toHaveAttribute("data-disabled")
    await user.hover(grip)
    expect(await screen.findByText("Drag to reorder works in Custom or Priority order")).toBeInTheDocument()
  })

  it("enables drag in custom order", async () => {
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    expect(screen.getByRole("button", { name: "Drag to reorder alpha one" })).not.toHaveAttribute("data-disabled")
  })

  it("search terms narrow the list", async () => {
    wrap(<TaskList scope={{ kind: "all" }} />, ["alpha"])
    await screen.findByText("alpha one")
    expect(screen.queryByText("beta two")).toBeNull()
  })

  it("hides empty sections and labels a lone section not at all", async () => {
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    // Starred is empty (a drop target only while dragging), so only "Tasks" remains.
    expect(screen.queryByText("Starred")).toBeNull()
    expect(screen.queryByText("Tasks")).toBeNull()
  })

  it("labels sections when there is more than one", async () => {
    vi.mocked(api.tasks).mockResolvedValue([task(1, { starred: true }), task(2)])
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("task 2")
    expect(screen.getByText("Starred")).toBeInTheDocument()
    expect(screen.getByText("Tasks")).toBeInTheDocument()
  })

  it("caps its height at maxRows", async () => {
    wrap(<TaskList scope={{ kind: "all" }} maxRows={8} />)
    await screen.findByText("beta two")
    expect(screen.getByTestId("task-list-body")).toHaveStyle({ maxHeight: "240px", overflowY: "auto" })
  })
})

describe("dropPlanFor", () => {
  const prefs = { sort: "custom", priority: "all", showCompleted: false, includeArchived: false } as const
  const sections = buildSections([task(1), task(2), task(3), task(4, { starred: true })], prefs, [])

  it("moves down within a section: lands where the item it is over was", () => {
    // 1 over 3: arrayMove gives 2,3,1 → after 3.
    expect(dropPlanFor(sections, taskDraggableId(1), taskDraggableId(3), false)).toEqual({ place: { after: 3 } })
  })

  it("moves up within a section", () => {
    expect(dropPlanFor(sections, taskDraggableId(3), taskDraggableId(1), false)).toEqual({ place: { before: 1 } })
  })

  it("dropping on itself is a no-op", () => {
    expect(dropPlanFor(sections, taskDraggableId(2), taskDraggableId(2), false)).toEqual({})
  })

  it("into starred, over a task, stars it and places it next to that task", () => {
    expect(dropPlanFor(sections, taskDraggableId(2), taskDraggableId(4), false)).toEqual({
      place: { before: 4 }, patch: { starred: true },
    })
    expect(dropPlanFor(sections, taskDraggableId(2), taskDraggableId(4), true)).toEqual({
      place: { after: 4 }, patch: { starred: true },
    })
  })

  it("onto a section's droppable goes to its end", () => {
    expect(dropPlanFor(sections, taskDraggableId(4), sectionDroppableId("rest"), false)).toEqual({
      place: { after: 3 }, patch: { starred: false },
    })
  })

  it("ignores unknown ids", () => {
    expect(dropPlanFor(sections, taskDraggableId(1), "nope", false)).toEqual({})
    expect(dropPlanFor(sections, "nope", taskDraggableId(1), false)).toEqual({})
  })
})
