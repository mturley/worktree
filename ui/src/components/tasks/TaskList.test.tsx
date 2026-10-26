import { useState } from "react"
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
import { dropIndicatorFor, dropPlanFor, taskDraggableId } from "./taskDrag"

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
  lastQc = qc
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

/** The QueryClient of the latest wrap, for tests that stand in for SSE. */
let lastQc!: QueryClient

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

describe("TaskList priority menu", () => {
  it("picking a priority updates the task with it", async () => {
    vi.mocked(api.updateTask).mockResolvedValue(task(1, { priority: "high" }))
    const user = userEvent.setup()
    wrap(<TaskList scope={{ kind: "all" }} />)
    await user.click(await screen.findByRole("button", { name: "Priority of “alpha one”: None" }))
    await user.click(await screen.findByRole("menuitem", { name: /High/ }))
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(1, { priority: "high" }))
    expect(openId()).toBe("none")
  })
})

function ToolbarHarness() {
  const [prefs, set] = useTaskListPrefs()
  return <TaskListToolbar prefs={prefs} onChange={set} />
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

  it("has no pin", () => {
    wrap(<ToolbarHarness />)
    expect(screen.queryByRole("button", { name: /pin task list/i })).toBeNull()
  })
})

/**
 * jsdom has no layout: every element's scrollHeight and clientHeight are 0.
 * Mock both on the prototype so the list body reads as overflowing (or not).
 */
function mockOverflow(scrollHeight: number, clientHeight: number) {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scrollHeight })
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => clientHeight })
}
function unmockOverflow() {
  // Deleting the own properties restores Element.prototype's getters.
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
}

describe("TaskList expand footer", () => {
  const twelve = () => Array.from({ length: 12 }, (_, i) => task(i + 1))
  afterEach(unmockOverflow)

  it("offers Show all (N) when the capped list overflows, and calls onToggle", async () => {
    mockOverflow(500, 240)
    vi.mocked(api.tasks).mockResolvedValue(twelve())
    const onToggle = vi.fn()
    const user = userEvent.setup()
    wrap(<TaskList scope={{ kind: "all" }} maxRows={8} expand={{ expanded: false, onToggle }} />)
    await screen.findByText("task 12")
    const btn = await screen.findByRole("button", { name: "Show all (12)" })
    await user.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it("offers nothing when the list fits", async () => {
    mockOverflow(240, 240)
    vi.mocked(api.tasks).mockResolvedValue(twelve())
    wrap(<TaskList scope={{ kind: "all" }} maxRows={8} expand={{ expanded: false, onToggle: vi.fn() }} />)
    await screen.findByText("task 12")
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Show less" })).toBeNull()
  })

  it("expanded: Show less, and no cap", async () => {
    mockOverflow(500, 500)
    vi.mocked(api.tasks).mockResolvedValue(twelve())
    const onToggle = vi.fn()
    const user = userEvent.setup()
    wrap(<TaskList scope={{ kind: "all" }} maxRows={8} expand={{ expanded: true, onToggle }} />)
    await screen.findByText("task 12")
    expect(screen.getByTestId("task-list-body").style.maxHeight).toBe("")
    await user.click(screen.getByRole("button", { name: "Show less" }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it("Show less keeps the same button, and its focus", async () => {
    mockOverflow(500, 240)
    vi.mocked(api.tasks).mockResolvedValue(twelve())
    function Harness() {
      const [expanded, setExpanded] = useState(false)
      return <TaskList scope={{ kind: "all" }} maxRows={8} expand={{ expanded, onToggle: () => setExpanded((e) => !e) }} />
    }
    const user = userEvent.setup()
    wrap(<Harness />)
    const btn = await screen.findByRole("button", { name: "Show all (12)" })
    await user.click(btn)
    expect(btn).toHaveTextContent("Show less")
    await user.click(btn)
    expect(btn.isConnected).toBe(true)
    expect(btn).toHaveTextContent("Show all (12)")
    expect(document.activeElement).toBe(btn)
  })

  it("re-measures when labels appear with the count unchanged", async () => {
    // Seven rows fit the 240px cap (210px); a section label pushes it over.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => (document.body.textContent?.includes("No priority") ? 260 : 210),
    })
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 240 })
    vi.mocked(api.tasks).mockResolvedValue(Array.from({ length: 7 }, (_, i) => task(i + 1)))
    wrap(<TaskList scope={{ kind: "all" }} maxRows={8} expand={{ expanded: false, onToggle: vi.fn() }} />)
    await screen.findByText("task 7")
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull()
    // Priority sort labels its lone group: same seven tasks, taller content.
    act(() => {
      window.localStorage.setItem(TASK_LIST_KEY, JSON.stringify({ sort: "priority" }))
      window.dispatchEvent(new StorageEvent("storage", { key: TASK_LIST_KEY }))
    })
    expect(await screen.findByRole("button", { name: "Show all (7)" })).toBeInTheDocument()
  })

  it("watches the content under the cap, not only the capped box", async () => {
    // Each observation with the callback that would hear about it.
    const observed: { el: Element; cb: (entries: ResizeObserverEntry[]) => void }[] = []
    const Orig = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      cb: (entries: ResizeObserverEntry[]) => void
      constructor(cb: (entries: ResizeObserverEntry[]) => void) { this.cb = cb }
      observe(el: Element) { observed.push({ el, cb: this.cb }) }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    try {
      let tall = false
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => (tall ? 300 : 210) })
      Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 240 })
      vi.mocked(api.tasks).mockResolvedValue(Array.from({ length: 7 }, (_, i) => task(i + 1)))
      wrap(<TaskList scope={{ kind: "all" }} maxRows={8} expand={{ expanded: false, onToggle: vi.fn() }} />)
      await screen.findByText("task 7")
      const body = screen.getByTestId("task-list-body")
      const inner = observed.find(({ el }) => el !== body && body.contains(el))
      expect(inner).toBeDefined()
      // Only the content grew: tell just its observer.
      tall = true
      act(() => inner!.cb([]))
      expect(await screen.findByRole("button", { name: "Show all (7)" })).toBeInTheDocument()
    } finally {
      globalThis.ResizeObserver = Orig
    }
  })

  it("without expand, neither button renders", async () => {
    mockOverflow(500, 240)
    vi.mocked(api.tasks).mockResolvedValue(twelve())
    wrap(<TaskList scope={{ kind: "all" }} maxRows={8} />)
    await screen.findByText("task 12")
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Show less" })).toBeNull()
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

  it("an empty section renders nothing: no strip, no label", async () => {
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    expect(screen.queryByText(/Drag here/)).toBeNull()
    expect(document.querySelector("[data-task-strip]")).toBeNull()
    expect(document.querySelector("[data-task-section=starred]")).toBeNull()
    expect(screen.queryByText("Starred")).toBeNull()
    expect(screen.queryByText("Tasks")).toBeNull()
  })

  it("Priority sort labels each group that holds tasks and hides the empty ones", async () => {
    setPrefs({ sort: "priority" })
    vi.mocked(api.tasks).mockResolvedValue([task(1), task(2, { priority: "medium" })])
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("task 2")
    expect(screen.getByText("Medium")).toBeInTheDocument()
    expect(screen.getByText("No priority")).toBeInTheDocument()
    expect(screen.queryByText("High")).toBeNull()
    expect(screen.queryByText("Low")).toBeNull()
    expect(screen.queryByText(/Drag here/)).toBeNull()
    expect(document.querySelector("[data-task-strip]")).toBeNull()
  })

  it("Priority sort labels even a lone group", async () => {
    setPrefs({ sort: "priority" })
    vi.mocked(api.tasks).mockResolvedValue([task(2, { priority: "medium" })])
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("task 2")
    expect(screen.getByText("Medium")).toBeInTheDocument()
  })

  it("an empty list says so", async () => {
    vi.mocked(api.tasks).mockResolvedValue([])
    wrap(<TaskList scope={{ kind: "all" }} />)
    expect(await screen.findByText("No tasks.")).toBeInTheDocument()
    expect(screen.queryByText(/Drag here/)).toBeNull()
  })

  it("labels sections when there is more than one", async () => {
    vi.mocked(api.tasks).mockResolvedValue([task(1, { starred: true }), task(2)])
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("task 2")
    expect(screen.getByText("Starred")).toBeInTheDocument()
    expect(screen.getByText("Tasks")).toBeInTheDocument()
    document.querySelectorAll<HTMLElement>("[data-task-row]").forEach((r) =>
      expect(parseFloat(r.style.paddingLeft)).not.toBe(0))
  })

  it("an unlabelled list's rows are flush", async () => {
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    const rows = document.querySelectorAll<HTMLElement>("[data-task-row]")
    expect(rows.length).toBeGreaterThan(0)
    rows.forEach((r) => expect(parseFloat(r.style.paddingLeft)).toBe(0))
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
 * pick up, an arrow to move, Space to drop. jsdom has no layout, so rows
 * are laid out 30px apart in document order. The overlay measures as the
 * row it lifts.
 */
describe("TaskList keyboard drag", () => {
  const ROW = 30
  const rect = (top: number, height: number) =>
    ({ x: 0, y: top, top, left: 0, width: 300, height, right: 300, bottom: top + height, toJSON: () => ({}) }) as DOMRect
  const leaves = () => Array.from(document.querySelectorAll<HTMLElement>("[data-task-sortable]"))
  let lifted: HTMLElement | null = null

  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const all = leaves()
      const leafRect = (el: Element) => rect(all.indexOf(el as HTMLElement) * ROW, ROW)
      if (this.matches("[data-task-sortable]")) return leafRect(this)
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
    // Picking up a row adds no labels: nothing moves under it.
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

  const order = () => leaves().map((el) => Number(el.dataset.taskSortable))
  /** A promise and the handles to settle it, for an API call held in flight. */
  function deferred<T>() {
    let resolve!: (v: T) => void
    let reject!: (e: Error) => void
    const promise = new Promise<T>((rs, rj) => { resolve = rs; reject = rj })
    return { promise, resolve, reject }
  }

  it("a drop shows the new order at once, and holds it through a refetch until the save lands", async () => {
    vi.mocked(api.tasks).mockResolvedValue([task(1, { title: "alpha one" }), task(2, { title: "beta two" }), task(3, { title: "gamma" })])
    const save = deferred<undefined>()
    vi.mocked(api.moveTask).mockReturnValue(save.promise as never)
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("gamma")
    await drag("alpha one", "ArrowDown")
    // No snap back to the old order while the save is in flight.
    expect(order()).toEqual([2, 1, 3])
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledWith(1, { after: 2 }))

    // An SSE refetch mid-save still answers the old order: it must not show.
    await act(() => lastQc.invalidateQueries({ queryKey: ["tasks"] }))
    expect(order()).toEqual([2, 1, 3])

    // The save lands and the server agrees.
    vi.mocked(api.tasks).mockResolvedValue([
      task(2, { title: "beta two" }), task(1, { title: "alpha one", rank: "r2m" }), task(3, { title: "gamma" }),
    ])
    await act(async () => { save.resolve(undefined) })
    await waitFor(() => expect(order()).toEqual([2, 1, 3]))

    // From then on the server's order is what shows: nothing optimistic lingers.
    vi.mocked(api.tasks).mockResolvedValue([
      task(3, { title: "gamma", rank: "r0" }), task(2, { title: "beta two" }), task(1, { title: "alpha one", rank: "r2m" }),
    ])
    await act(() => lastQc.invalidateQueries({ queryKey: ["tasks"] }))
    await waitFor(() => expect(order()).toEqual([3, 2, 1]))
  })

  it("a failed drop puts the old order back and says why", async () => {
    const save = deferred<undefined>()
    vi.mocked(api.moveTask).mockReturnValue(save.promise as never)
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    await drag("alpha one", "ArrowDown")
    expect(order()).toEqual([2, 1])
    await act(async () => { save.reject(new Error("boom")) })
    await waitFor(() => expect(order()).toEqual([1, 2]))
    expect(screen.getByText("boom")).toBeInTheDocument()
  })

  it("while dragging, the source slot is an empty placeholder and the copy is opaque", async () => {
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    const grip = screen.getByRole("button", { name: "Drag to reorder alpha one" })
    lifted = grip.closest<HTMLElement>("[data-task-sortable]")
    act(() => grip.focus())
    fireEvent.keyDown(grip, { code: "Space", key: " " })
    const overlay = await screen.findByTestId("task-drag-overlay")
    expect(overlay).toHaveClass("task-drag-overlay")
    // Not the panel's translucent wash: the rows beneath must not show through.
    expect(overlay).not.toHaveClass("task-panel")
    expect(lifted).toHaveAttribute("data-dragging")
    expect(lifted).toHaveClass("task-drag-placeholder")
    fireEvent.keyDown(grip, { code: "Escape", key: "Escape" })
    await waitFor(() => expect(lifted).not.toHaveAttribute("data-dragging"))
  })

  it("a drag into another section marks where it will land, before the row it is over", async () => {
    vi.mocked(api.tasks).mockResolvedValue([
      task(4, { title: "star four", starred: true }), task(1, { title: "alpha one" }), task(2, { title: "beta two" }),
    ])
    vi.mocked(api.moveTask).mockResolvedValue(undefined as never)
    vi.mocked(api.updateTask).mockResolvedValue(undefined as never)
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("star four")
    const grip = screen.getByRole("button", { name: "Drag to reorder star four" })
    lifted = grip.closest<HTMLElement>("[data-task-sortable]")
    act(() => grip.focus())
    fireEvent.keyDown(grip, { code: "Space", key: " " })
    await screen.findByTestId("task-drag-overlay")
    expect(document.querySelector("[data-task-drop-line]")).toBeNull()
    fireEvent.keyDown(grip, { code: "ArrowDown", key: "ArrowDown" })

    const alpha = document.querySelector<HTMLElement>('[data-task-sortable="1"]')!
    await waitFor(() => expect(alpha.querySelector("[data-task-drop-line]")).toHaveAttribute("data-task-drop-line", "before"))
    expect(document.querySelectorAll("[data-task-drop-line]")).toHaveLength(1)
    expect(document.querySelector('[data-task-section="rest"]')).toHaveAttribute("data-drop-target")
    expect(document.querySelector('[data-task-section="starred"]')).not.toHaveAttribute("data-drop-target")

    // And the drop lands exactly there.
    fireEvent.keyDown(grip, { code: "Space", key: " " })
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledWith(4, { before: 1 }))
    expect(api.updateTask).toHaveBeenCalledWith(4, { starred: false })
    expect(document.querySelector("[data-task-drop-line]")).toBeNull()
    expect(document.querySelector("[data-drop-target]")).toBeNull()
  })

  it("a drag within a section marks no line: its open slot already shows where it lands", async () => {
    vi.mocked(api.tasks).mockResolvedValue([task(1, { title: "alpha one" }), task(2, { title: "beta two" }), task(3, { title: "gamma" })])
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("gamma")
    const grip = screen.getByRole("button", { name: "Drag to reorder alpha one" })
    lifted = grip.closest<HTMLElement>("[data-task-sortable]")
    act(() => grip.focus())
    fireEvent.keyDown(grip, { code: "Space", key: " " })
    await screen.findByTestId("task-drag-overlay")
    fireEvent.keyDown(grip, { code: "ArrowDown", key: "ArrowDown" })
    await act(() => new Promise((r) => setTimeout(r, 0)))
    expect(document.querySelector("[data-task-drop-line]")).toBeNull()
    expect(document.querySelector("[data-drop-target]")).toBeNull()
    fireEvent.keyDown(grip, { code: "Escape", key: "Escape" })
  })

  it("Custom sort: reorders through mutations.move", async () => {
    vi.mocked(api.moveTask).mockResolvedValue(undefined as never)
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    await drag("alpha one", "ArrowDown")
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledWith(1, { after: 2 }))
    expect(api.updateTask).not.toHaveBeenCalled()
  })

  it("Priority sort: a drag into another non-empty group patches priority and places it", async () => {
    setPrefs({ sort: "priority" })
    vi.mocked(api.tasks).mockResolvedValue([
      task(1, { title: "alpha one", priority: "high" }),
      task(2, { title: "beta two", priority: "medium" }),
    ])
    vi.mocked(api.moveTask).mockResolvedValue(undefined as never)
    vi.mocked(api.updateTask).mockResolvedValue(undefined as never)
    wrap(<TaskList scope={{ kind: "all" }} />)
    await screen.findByText("beta two")
    await drag("alpha one", "ArrowDown")
    await waitFor(() => expect(api.moveTask).toHaveBeenCalledTimes(1))
    expect(api.moveTask).toHaveBeenCalledWith(1, { before: 2 })
    expect(api.updateTask).toHaveBeenCalledWith(1, { priority: "medium" })
  })
})

describe("dropPlanFor", () => {
  const prefs = { sort: "custom", showCompleted: false, includeArchived: false } as const
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

  it("dropIndicatorFor marks the row the plan places against, on the side it lands", () => {
    expect(dropIndicatorFor(sections, taskDraggableId(2), taskDraggableId(4), false)).toEqual({ section: "starred", id: 4, edge: "before" })
    expect(dropIndicatorFor(sections, taskDraggableId(2), taskDraggableId(4), true)).toEqual({ section: "starred", id: 4, edge: "after" })
    expect(dropIndicatorFor(sections, taskDraggableId(4), taskDraggableId(3), true)).toEqual({ section: "rest", id: 3, edge: "after" })
  })

  it("dropIndicatorFor marks nothing within a section, or for a drop that goes nowhere", () => {
    expect(dropIndicatorFor(sections, taskDraggableId(1), taskDraggableId(3), false)).toBeNull()
    expect(dropIndicatorFor(sections, taskDraggableId(1), "nope", false)).toBeNull()
  })

  it("ignores unknown ids", () => {
    expect(dropPlanFor(sections, taskDraggableId(1), "nope", false)).toEqual({})
    expect(dropPlanFor(sections, "nope", taskDraggableId(1), false)).toEqual({})
  })
})
