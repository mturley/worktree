import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Router } from "wouter"
import { memoryLocation } from "wouter/memory-location"
import { api } from "../../api/client"
import type { Task } from "../../api/types"
import type { TaskScope } from "../../hooks/useTasks"
import { TASK_LIST_KEY } from "../../lib/taskListPrefs"
import { TaskModalProvider } from "./modal/TaskModalProvider"
import { scopeContext, useTasksPanel } from "./TasksSection"

vi.mock("../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../api/client")>()),
  api: { tasks: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(), setTaskState: vi.fn(), moveTask: vi.fn() },
}))

const task = (id: number, extra: Partial<Task> = {}): Task => ({
  id, ref: `T${id}`, title: `task ${id}`, description: "", state: "not_started", priority: "none", starred: false,
  rank: `r${id}`, created_at: "", updated_at: "", archived: false, links: [], implicit_worktrees: [],
  subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, blocker_labels: [], ...extra,
})

const ALL: TaskScope = { kind: "all" }

/** A page's shape: the panel above its tab bar. */
function Host({ scope = ALL, unread, resetKey, testId = "host" }: {
  scope?: TaskScope
  unread?: number
  resetKey?: string
  testId?: string
}) {
  const t = useTasksPanel(scope, { unread, resetKey })
  return (
    <div data-testid={testId} data-expanded={t.expanded}>
      {t.above(<div data-testid="bar">tab bar</div>)}
    </div>
  )
}

function wrap(ui: React.ReactNode, path = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const loc = memoryLocation({ path })
  const tree = (node: React.ReactNode) => (
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <Router hook={loc.hook}>
          <TaskModalProvider>{node}</TaskModalProvider>
        </Router>
      </QueryClientProvider>
    </MantineProvider>
  )
  const r = render(tree(ui))
  return { ...r, navigate: loc.navigate, rerender: (node: React.ReactNode) => r.rerender(tree(node)) }
}

const panel = (root: HTMLElement | Document = document) =>
  within(root as HTMLElement).getByTestId("tasks-panel")

/**
 * jsdom has no layout: mock scrollHeight over clientHeight so the capped
 * list reads as overflowing, and Show all is offered.
 */
function mockOverflow() {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 500 })
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 240 })
}
function unmockOverflow() {
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
}

async function expand() {
  await userEvent.click(await within(panel()).findByRole("button", { name: /^Show all \(/ }))
  expect(panel()).toHaveAttribute("data-level", "expanded")
}

beforeEach(() => {
  vi.mocked(api.tasks).mockResolvedValue([task(1), task(2), task(3, { state: "done" })])
})
afterEach(() => {
  cleanup()
  unmockOverflow()
  vi.clearAllMocks()
  window.localStorage.clear()
})

describe("useTasksPanel", () => {
  it("is normal by default: the count, the toolbar and the list, above the tab bar", async () => {
    wrap(<Host />)
    const p = panel()
    expect(p).toHaveAttribute("data-level", "normal")
    expect(await within(p).findByText("Tasks (all)")).toBeInTheDocument()
    expect(within(p).getByLabelText("Sort tasks")).toBeInTheDocument()
    expect(await within(p).findByText("task 1")).toBeInTheDocument()
    expect(within(p).getByPlaceholderText("Add a task…")).toBeInTheDocument()
    // Panel first, then the bar.
    expect(p.compareDocumentPosition(screen.getByTestId("bar")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("the normal list is capped by rows and by the viewport", async () => {
    wrap(<Host />)
    await within(panel()).findByText("task 1")
    expect(within(panel()).getByTestId("task-list-body").style.maxHeight).toBe("min(240px, 25dvh)")
  })

  it("collapses to one line, saved globally, and expands back to normal", async () => {
    wrap(
      <>
        <Host testId="a" />
        <Host testId="b" />
      </>,
    )
    const a = () => panel(screen.getByTestId("a"))
    const b = () => panel(screen.getByTestId("b"))
    await within(a()).findByText("Tasks (all)")
    await userEvent.click(within(a()).getByRole("button", { name: /^Collapse task list/ }))

    expect(a()).toHaveAttribute("data-level", "collapsed")
    expect(within(a()).queryByLabelText("Sort tasks")).toBeNull()
    expect(within(a()).queryByPlaceholderText("Add a task…")).toBeNull()
    expect(within(a()).queryByTestId("task-list-body")).toBeNull()
    const line = within(a()).getByRole("button", { name: /^Expand task list/ })
    expect(within(line).getByText("Tasks (all) · 2 open")).toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem(TASK_LIST_KEY)!).collapsed).toBe(true)
    // ONE global setting: the other panel collapsed too.
    expect(b()).toHaveAttribute("data-level", "collapsed")

    await userEvent.click(line)
    expect(a()).toHaveAttribute("data-level", "normal")
    expect(b()).toHaveAttribute("data-level", "normal")
  })

  it("Show all expands, without saving anything about it; Show less returns to normal", async () => {
    mockOverflow()
    wrap(<Host />)
    await within(panel()).findByText("task 1")
    await expand()
    expect(screen.getByTestId("host")).toHaveAttribute("data-expanded", "true")
    expect(within(panel()).getByTestId("task-list-body").style.maxHeight).toBe("")
    const stored = window.localStorage.getItem(TASK_LIST_KEY)
    expect(stored === null ? {} : JSON.parse(stored)).not.toHaveProperty("expanded")
    await userEvent.click(within(panel()).getByRole("button", { name: "Show less" }))
    expect(panel()).toHaveAttribute("data-level", "normal")
  })

  it("collapsing from expanded clears it: expanding the line comes back normal", async () => {
    mockOverflow()
    wrap(<Host />)
    await within(panel()).findByText("task 1")
    await expand()
    await userEvent.click(within(panel()).getByRole("button", { name: /^Collapse task list/ }))
    await userEvent.click(within(panel()).getByRole("button", { name: /^Expand task list/ }))
    expect(panel()).toHaveAttribute("data-level", "normal")
  })

  it("expanded resets to normal on navigation to another path", async () => {
    mockOverflow()
    const { navigate } = wrap(<Host />, "/a")
    await within(panel()).findByText("task 1")
    await expand()
    act(() => navigate("/b"))
    expect(panel()).toHaveAttribute("data-level", "normal")
    // Coming back does not restore it.
    act(() => navigate("/a"))
    expect(panel()).toHaveAttribute("data-level", "normal")
  })

  it("expanded resets to normal on a change of scope, and survives a re-render with the same one", async () => {
    mockOverflow()
    const { rerender } = wrap(<Host scope={{ kind: "worktree", path: "/w" }} />)
    await within(panel()).findByText("task 1")
    await expand()
    // A new but equal scope object: still expanded.
    rerender(<Host scope={{ kind: "worktree", path: "/w" }} />)
    expect(panel()).toHaveAttribute("data-level", "expanded")
    rerender(<Host scope={{ kind: "resource", type: "github_pr", id: "o/r#1" }} />)
    expect(panel()).toHaveAttribute("data-level", "normal")
  })

  it("a change of resetKey resets expanded, and changing it back stays normal", async () => {
    mockOverflow()
    const { rerender } = wrap(<Host resetKey="" />)
    await within(panel()).findByText("task 1")
    await expand()
    rerender(<Host resetKey="" />)
    expect(panel()).toHaveAttribute("data-level", "expanded")
    rerender(<Host resetKey="pr:o/r#1" />)
    expect(panel()).toHaveAttribute("data-level", "normal")
    rerender(<Host resetKey="" />)
    expect(panel()).toHaveAttribute("data-level", "normal")
  })

  it("a collapse from another browser tab clears expanded: un-collapsing gives normal", async () => {
    mockOverflow()
    wrap(<Host />)
    await within(panel()).findByText("task 1")
    await expand()
    const fromOtherTab = (collapsed: boolean) =>
      act(() => {
        window.localStorage.setItem(TASK_LIST_KEY, JSON.stringify({ collapsed }))
        window.dispatchEvent(new StorageEvent("storage", { key: TASK_LIST_KEY }))
      })
    fromOtherTab(true)
    expect(panel()).toHaveAttribute("data-level", "collapsed")
    fromOtherTab(false)
    expect(panel()).toHaveAttribute("data-level", "normal")
  })

  it("unread task events: a dot in the normal header and on the collapsed line", async () => {
    wrap(<Host unread={2} />)
    expect(within(panel()).getByRole("img", { name: "unread task activity" })).toBeInTheDocument()
    await userEvent.click(within(panel()).getByRole("button", { name: /^Collapse task list/ }))
    const line = within(panel()).getByRole("button", { name: /^Expand task list/ })
    expect(within(line).getByRole("img", { name: "unread task activity" })).toBeInTheDocument()
  })

  it("no unread task events: no dot", () => {
    wrap(<Host unread={0} />)
    expect(screen.queryByRole("img", { name: "unread task activity" })).toBeNull()
  })

  it("the collapsed line's name carries the count and the unread state", async () => {
    const { rerender } = wrap(<Host unread={2} />)
    await within(panel()).findByText("Tasks (all)")
    await userEvent.click(within(panel()).getByRole("button", { name: /^Collapse task list/ }))
    expect(within(panel()).getByRole("button", { name: "Expand task list (2 open, unread activity)" })).toBeInTheDocument()
    rerender(<Host unread={0} />)
    expect(within(panel()).getByRole("button", { name: "Expand task list (2 open)" })).toBeInTheDocument()
  })
})

describe("useTasksPanel summary toggle", () => {
  it("cycles normal → expanded → collapsed → normal when the list overflows", async () => {
    mockOverflow()
    try {
      const user = userEvent.setup()
      wrap(<Host />)
      await within(panel()).findByText("Tasks (all)")
      const toggle = await within(panel()).findByRole("button", { name: /^Show all tasks/ })
      await user.click(toggle)
      expect(panel()).toHaveAttribute("data-level", "expanded")
      expect(toggle).toHaveAccessibleName(/^Collapse task list/)
      await user.click(toggle)
      expect(panel()).toHaveAttribute("data-level", "collapsed")
      expect(toggle).toHaveAccessibleName(/^Expand task list/)
      await user.click(toggle)
      expect(panel()).toHaveAttribute("data-level", "normal")
    } finally {
      unmockOverflow()
    }
  })

  it("goes straight from normal to collapsed when the list fits", async () => {
    const user = userEvent.setup()
    wrap(<Host />)
    await within(panel()).findByText("Tasks (all)")
    await user.click(within(panel()).getByRole("button", { name: /^Collapse task list/ }))
    expect(panel()).toHaveAttribute("data-level", "collapsed")
  })
})

describe("scopeContext", () => {
  it("names which tasks the panel lists", () => {
    expect(scopeContext({ kind: "all" })).toBe("all")
    expect(scopeContext({ kind: "worktree", path: "/w" })).toBe("this worktree")
    expect(scopeContext({ kind: "resource", type: "pr", id: "o/r#1" })).toBe("this PR")
    expect(scopeContext({ kind: "resource", type: "jira", id: "J-1" })).toBe("this issue")
    expect(scopeContext({ kind: "resource", type: "slack", id: "C1:1.2" })).toBe("this thread")
    expect(scopeContext({ kind: "resource", type: "link", id: "https://x" })).toBe("this link")
    expect(scopeContext({ kind: "resource", type: "other", id: "x" })).toBe("this resource")
  })
})

describe("useTasksPanel focus", () => {
  it("one toggle, holding the summary, collapses and expands and keeps the focus", async () => {
    const user = userEvent.setup()
    wrap(<Host />)
    await within(panel()).findByText("Tasks (all)")
    const toggle = within(panel()).getByRole("button", { name: /^Collapse task list/ })
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(toggle).toHaveTextContent(/^Tasks \(all\)$/)
    await user.click(toggle)
    expect(panel()).toHaveAttribute("data-level", "collapsed")
    expect(toggle).toHaveTextContent("Tasks (all) · 2 open")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(within(panel()).getByRole("button", { name: /^Expand task list/ })).toBe(toggle)
    expect(document.activeElement).toBe(toggle)

    await user.keyboard("{Enter}")
    expect(panel()).toHaveAttribute("data-level", "normal")
    expect(document.activeElement).toBe(toggle)
  })

  it("leaves focus alone when the toggle was not focused", async () => {
    wrap(<Host />)
    await within(panel()).findByText("Tasks (all)")
    act(() => within(panel()).getByRole("button", { name: /^Collapse task list/ }).click())
    expect(panel()).toHaveAttribute("data-level", "collapsed")
    expect(document.activeElement).toBe(document.body)
  })
})

/**
 * jsdom has no layout: getBoundingClientRect is stubbed so the panel sits at
 * `top`, and scrollIntoView (which jsdom lacks) records which element asked.
 */
describe("useTasksPanel keeps an expanded panel in view", () => {
  let scrolled: Element[] = []
  let calls: unknown[] = []
  function place(top: number) {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const t = this.matches("[data-testid=tasks-panel]") ? top : 0
      return { x: 0, y: t, top: t, left: 0, width: 300, height: 100, right: 300, bottom: t + 100, toJSON: () => ({}) } as DOMRect
    })
  }
  beforeEach(() => {
    scrolled = []
    calls = []
    Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) {
      scrolled.push(this)
      calls.push(arg)
    }
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it("scrolls the panel to the top when expanding leaves it above the viewport", async () => {
    mockOverflow()
    wrap(<Host />)
    await within(panel()).findByText("task 1")
    place(-400)
    await expand()
    expect(scrolled).toEqual([panel()])
    expect(calls).toEqual([{ block: "start" }])
  })

  it("does not scroll when the expanded panel is still in view", async () => {
    mockOverflow()
    wrap(<Host />)
    await within(panel()).findByText("task 1")
    place(50)
    await expand()
    expect(scrolled).toEqual([])
  })

  it("counts a page header's inset as out of view, and margins the scroll by it", async () => {
    mockOverflow()
    function Inset() {
      const t = useTasksPanel(ALL, { topInset: 80 })
      return <>{t.panel}</>
    }
    wrap(<Inset />)
    await within(panel()).findByText("task 1")
    expect(panel().style.scrollMarginTop).toBe("80px")
    place(40)
    await expand()
    expect(scrolled).toEqual([panel()])
  })

  it("does not scroll on Show less", async () => {
    mockOverflow()
    wrap(<Host />)
    await within(panel()).findByText("task 1")
    place(50)
    await expand()
    place(-400)
    await userEvent.click(within(panel()).getByRole("button", { name: "Show less" }))
    expect(scrolled).toEqual([])
  })
})
