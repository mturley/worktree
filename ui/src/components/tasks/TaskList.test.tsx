import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { Notifications, notifications } from "@mantine/notifications"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { Task } from "../../api/types"
import { SearchContext } from "../search/SearchContext"
import { TASK_LIST_KEY } from "../../lib/taskListPrefs"
import { buildSections } from "../../lib/taskSections"
import { useTaskListPrefs } from "../../hooks/useTaskListPrefs"
import { TaskList } from "./TaskList"
import { TaskModalProvider, useTaskModal } from "./modal/TaskModalProvider"
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
    undoTask: vi.fn(),
  },
}))

const task = (id: number, extra: Partial<Task> = {}): Task => ({
  id, ref: `T${id}`, title: `task ${id}`, description: "", state: "not_started", priority: "none", starred: false,
  rank: `r${id}`, created_at: "", updated_at: "", archived: false, links: [], implicit_worktrees: [],
  subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, blocker_labels: [], ...extra,
})

/** Shows which task the modal has open. */
function OpenProbe() {
  const { openId } = useTaskModal()
  return <span data-testid="open-id">{openId ?? "none"}</span>
}
const openId = () => screen.getByTestId("open-id").textContent

function wrap(ui: React.ReactNode, terms: string[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider client={qc}>
        <TaskModalProvider>
          <SearchContext.Provider value={{ terms }}>{ui}</SearchContext.Provider>
          <OpenProbe />
        </TaskModalProvider>
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
  notifications.clean()
  vi.clearAllMocks()
  window.localStorage.clear()
  // The modal lives in ?task=; jsdom's URL outlives a test.
  window.history.replaceState({}, "", "/")
})

describe("TaskList undo", () => {
  it("a row's state change offers an undo, which takes back its event", async () => {
    vi.mocked(api.setTaskState).mockResolvedValue(task(1, { state: "in_progress", undo_event_id: 41 }))
    vi.mocked(api.undoTask).mockResolvedValue(undefined)
    const user = userEvent.setup()
    wrap(<TaskList scope={{ kind: "all" }} />)
    await user.click(await screen.findByRole("button", { name: "State of “alpha one”: Not started" }))
    await user.click(await screen.findByRole("menuitem", { name: "In progress" }))
    expect(await screen.findByText("Marked “alpha one” in progress")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Undo" }))
    expect(api.undoTask).toHaveBeenCalledWith(41)
  })

  it("offers no undo when the change changed nothing", async () => {
    vi.mocked(api.setTaskState).mockResolvedValue(task(1))
    const user = userEvent.setup()
    wrap(<TaskList scope={{ kind: "all" }} />)
    await user.click(await screen.findByRole("button", { name: "State of “alpha one”: Not started" }))
    await user.click(await screen.findByRole("menuitem", { name: "Not started" }))
    await waitFor(() => expect(api.setTaskState).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument()
  })
})

describe("TaskList opens the modal", () => {
  it("a row click opens its task", async () => {
    const user = userEvent.setup()
    wrap(<TaskList scope={{ kind: "all" }} />)
    await user.click(await screen.findByRole("button", { name: "beta two" }))
    expect(openId()).toBe("2")
    expect(new URLSearchParams(window.location.search).get("task")).toBe("2")
  })

  it("picking a state from a row's portalled menu changes state without opening", async () => {
    vi.mocked(api.setTaskState).mockResolvedValue(task(1, { state: "done" }))
    const user = userEvent.setup()
    wrap(<TaskList scope={{ kind: "all" }} />)
    await user.click(await screen.findByRole("button", { name: "State of “alpha one”: Not started" }))
    await user.click(await screen.findByRole("menuitem", { name: "Done" }))
    await waitFor(() => expect(api.setTaskState).toHaveBeenCalled())
    expect(openId()).toBe("none")
  })

  it("Add & open creates the task and opens the new id; Enter only adds", async () => {
    const user = userEvent.setup()
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    const input = screen.getByRole("textbox", { name: "New task" })
    await user.type(input, "stay{Enter}")
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(input).toHaveValue(""))
    expect(openId()).toBe("none")
    await user.type(input, "go")
    await user.click(screen.getByRole("button", { name: "Add & open" }))
    await waitFor(() => expect(openId()).toBe("9"))
    expect(api.createTask).toHaveBeenCalledTimes(2)
    expect(api.createTask).toHaveBeenLastCalledWith({ title: "go", priority: "none", starred: false, after: 2 })
  })
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

  it("in a non-draggable sort, adds after the open task last in MASTER order, not display order", async () => {
    setPrefs({ sort: "due" })
    // Due order shows 2 (due) before 1 (no due); master order is 1, 2, so the
    // display's last row (1) is the wrong anchor.
    vi.mocked(api.tasks).mockResolvedValue([
      task(1, { title: "alpha one" }), task(2, { title: "beta two", due: "2026-01-01" }),
      task(3, { title: "done", state: "done", rank: "r9" }),
    ])
    const user = userEvent.setup()
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    await user.type(screen.getByRole("textbox", { name: "New task" }), "next{Enter}")
    await waitFor(() => expect(api.createTask).toHaveBeenCalled())
    expect(api.createTask).toHaveBeenCalledWith({ title: "next", priority: "none", starred: false, after: 2 })
  })

  it("seeds the priority picker from the active priority filter, so the new task stays visible", async () => {
    setPrefs({ priority: "high" })
    vi.mocked(api.tasks).mockResolvedValue([task(1, { title: "alpha one", priority: "high" })])
    const user = userEvent.setup()
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("alpha one")
    const input = screen.getByRole("textbox", { name: "New task" })
    await user.click(input)
    expect(screen.getByRole("textbox", { name: "New task priority" })).toHaveValue("High")
    await user.type(input, "urgent{Enter}")
    await waitFor(() => expect(api.createTask).toHaveBeenCalled())
    expect(api.createTask).toHaveBeenCalledWith({ title: "urgent", priority: "high", starred: false, after: 1 })
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

  it("an empty Starred section is a slim strip at rest, and a lone section has no label", async () => {
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    // Present before any drag, so starting one shifts nothing.
    expect(screen.getByText("Drag here to star")).toBeInTheDocument()
    expect(screen.queryByText("Starred")).toBeNull()
    expect(screen.queryByText("Tasks")).toBeNull()
  })

  it("Priority sort labels every group and shows empty ones as strips at rest", async () => {
    setPrefs({ sort: "priority" })
    vi.mocked(api.tasks).mockResolvedValue([task(1, { priority: "high" }), task(2)])
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("task 2")
    for (const label of ["High", "Medium", "Low", "No priority"]) expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByText("Drag here for medium priority")).toBeInTheDocument()
    expect(screen.getByText("Drag here for low priority")).toBeInTheDocument()
    expect(screen.getByText("Drag here to star")).toBeInTheDocument()
  })

  it("no strips outside the draggable sorts", async () => {
    setPrefs({ sort: "due" })
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    expect(screen.queryByText("Drag here to star")).toBeNull()
  })

  it("an empty list says so rather than showing bare strips", async () => {
    vi.mocked(api.tasks).mockResolvedValue([])
    wrap(<TaskList scope={{ kind: "all" }} />)
    expect(await screen.findByText("No tasks.")).toBeInTheDocument()
    expect(screen.queryByText("Drag here to star")).toBeNull()
  })

  it("labels sections when there is more than one", async () => {
    vi.mocked(api.tasks).mockResolvedValue([task(1, { starred: true }), task(2)])
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("task 2")
    expect(screen.getByText("Starred")).toBeInTheDocument()
    expect(screen.getByText("Tasks")).toBeInTheDocument()
  })

  it("caps its height at maxRows, and at a quarter of the viewport", async () => {
    wrap(<TaskList scope={{ kind: "all" }} maxRows={8} />)
    await screen.findByText("beta two")
    const body = screen.getByTestId("task-list-body")
    expect(body.style.maxHeight).toBe("min(240px, 25dvh)")
    expect(body).toHaveStyle({ overflowY: "auto" })
  })
})

/*
 * End-to-end drags through dnd-kit's KeyboardSensor: focus a grip, Space to
 * pick up, an arrow to move, Space to drop. jsdom has no layout, so rows and
 * empty-section strips are laid out 30px apart in document order, and a
 * section's drop area spans what it holds. The overlay measures as the row
 * it lifts.
 */
describe("TaskList keyboard drag", () => {
  const ROW = 30
  const rect = (top: number, height: number) =>
    ({ x: 0, y: top, top, left: 0, width: 300, height, right: 300, bottom: top + height, toJSON: () => ({}) }) as DOMRect
  const leaves = () => Array.from(document.querySelectorAll<HTMLElement>("[data-task-sortable],[data-task-strip]"))
  let lifted: HTMLElement | null = null

  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const all = leaves()
      const leafRect = (el: Element) => rect(all.indexOf(el as HTMLElement) * ROW, ROW)
      if (this.matches("[data-task-sortable],[data-task-strip]")) return leafRect(this)
      if (this.matches("[data-task-drop]")) {
        const inner = all.filter((l) => this.contains(l))
        if (inner.length === 0) return rect(0, 0)
        const top = all.indexOf(inner[0]) * ROW
        return rect(top, inner.length * ROW)
      }
      // dnd-kit measures the overlay by its content.
      if (lifted && this.matches("[data-testid=task-drag-overlay]")) return leafRect(lifted)
      return rect(0, 0)
    })
  })
  afterEach(() => {
    lifted = null
    vi.mocked(Element.prototype.getBoundingClientRect).mockRestore()
  })

  async function drag(title: string, key: "ArrowDown" | "ArrowUp") {
    const grip = screen.getByRole("button", { name: `Drag to reorder ${title}` })
    lifted = grip.closest<HTMLElement>("[data-task-sortable]")
    const before = leaves().length
    act(() => grip.focus())
    fireEvent.keyDown(grip, { code: "Space", key: " " })
    // Picking up a row adds no labels or strips: nothing moves under it.
    expect(leaves()).toHaveLength(before)
    expect(await screen.findByTestId("task-drag-overlay")).toHaveTextContent(title)
    fireEvent.keyDown(grip, { code: key, key })
    fireEvent.keyDown(grip, { code: "Space", key: " " })
  }

  it("a grip press without a drag, a keyboard drag, and the click after a mouse drag do not open the modal", async () => {
    vi.mocked(api.moveTask).mockResolvedValue(undefined as never)
    const user = userEvent.setup()
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    // A plain click on the grip.
    await user.click(screen.getByRole("button", { name: "Drag to reorder alpha one" }))
    expect(openId()).toBe("none")

    // A keyboard drag: Space/Enter on the grip are the sensor's, not the row's.
    await drag("alpha one", "ArrowDown")
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledTimes(1))
    expect(openId()).toBe("none")

    // A mouse drag past the 4px threshold, then the click the browser fires
    // on release, landing on the row: dnd-kit swallows it at the document.
    const grip = screen.getByRole("button", { name: "Drag to reorder beta two" })
    lifted = grip.closest<HTMLElement>("[data-task-sortable]")
    fireEvent.mouseDown(grip, { button: 0, clientX: 5, clientY: 5 })
    fireEvent.mouseMove(document, { clientX: 5, clientY: 20 })
    expect(await screen.findByTestId("task-drag-overlay")).toHaveTextContent("beta two")
    fireEvent.mouseUp(document, { clientX: 5, clientY: 20 })
    const row = lifted!.querySelector<HTMLElement>("[data-task-row]")!
    fireEvent.click(row)
    expect(openId()).toBe("none")
    // The control: once dnd-kit's 50ms suppression lapses, the same click opens.
    await act(() => new Promise((r) => setTimeout(r, 80)))
    fireEvent.click(row)
    expect(openId()).toBe("2")
  })

  it("Custom sort: reorders through mutations.move", async () => {
    vi.mocked(api.moveTask).mockResolvedValue(undefined as never)
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    await drag("alpha one", "ArrowDown")
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledWith(1, { after: 2 }))
    expect(api.updateTask).not.toHaveBeenCalled()
  })

  it("Priority sort: a drag into another group patches priority and places it", async () => {
    setPrefs({ sort: "priority" })
    vi.mocked(api.tasks).mockResolvedValue([task(1, { title: "alpha one", priority: "high" }), task(2, { title: "beta two" })])
    vi.mocked(api.moveTask).mockResolvedValue(undefined as never)
    vi.mocked(api.updateTask).mockResolvedValue(undefined as never)
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    // Down from High lands on Medium's empty strip.
    await drag("alpha one", "ArrowDown")
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledWith(1, { before: 2 }))
    expect(api.updateTask).toHaveBeenCalledWith(1, { priority: "medium" })
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
