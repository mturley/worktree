import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider, Tabs } from "@mantine/core"
import { TaskModalProvider } from "./modal/TaskModalProvider"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../../api/client"
import type { Task } from "../../api/types"
import { TASK_LIST_KEY } from "../../lib/taskListPrefs"
import { tasksFallbackTab, useResourceTasksPlacement, useTasksPlacement } from "./TasksSection"

vi.mock("../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../api/client")>()),
  api: { tasks: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(), setTaskState: vi.fn(), moveTask: vi.fn() },
}))

const task = (id: number, extra: Partial<Task> = {}): Task => ({
  id, ref: `T${id}`, title: `task ${id}`, description: "", state: "not_started", priority: "none", starred: false,
  rank: `r${id}`, created_at: "", updated_at: "", archived: false, links: [], implicit_worktrees: [],
  subtasks_total: 0, subtasks_done: 0, ...extra,
})

/** A two-tab host shaped like the pages': Activity, then Tasks last. */
function Host({ unread }: { unread?: number }) {
  const [tab, setTab] = useState("timeline")
  const p = useTasksPlacement({ kind: "all" }, undefined, { activeTab: tab, onFallback: () => setTab("timeline"), unread })
  const shown = tasksFallbackTab(tab, p.pinned, "timeline")
  return (
    <>
      {p.pinnedPanel}
      <Tabs value={shown} onChange={(v) => v && setTab(v)}>
        <Tabs.List>
          <Tabs.Tab value="timeline">Activity</Tabs.Tab>
          {p.tab}
          <div data-testid="bar-end">{shown === "tasks" && p.toolbar}</div>
        </Tabs.List>
        <Tabs.Panel value="timeline">activity body</Tabs.Panel>
        <Tabs.Panel value="tasks">{p.tabPanelBody}</Tabs.Panel>
      </Tabs>
    </>
  )
}

function wrap(unread?: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}><TaskModalProvider><Host unread={unread} /></TaskModalProvider></QueryClientProvider>
    </MantineProvider>,
  )
}

beforeEach(() => {
  vi.mocked(api.tasks).mockResolvedValue([task(1), task(2), task(3, { state: "done" })])
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.localStorage.clear()
})

describe("tasksFallbackTab", () => {
  it("swaps tasks for the fallback only while pinned", () => {
    expect(tasksFallbackTab("tasks", true, "timeline")).toBe("timeline")
    expect(tasksFallbackTab("tasks", false, "timeline")).toBe("tasks")
    expect(tasksFallbackTab("resources", true, "timeline")).toBe("resources")
  })
})

describe("useTasksPlacement", () => {
  it("not pinned: a Tasks tab with the open count, hidden while active; the toolbar offers Pin", async () => {
    wrap()
    const tab = screen.getByRole("tab", { name: /Tasks/ })
    expect((await within(tab).findByText("2")).closest(".task-count-badge")).not.toBeNull()
    expect(document.querySelector(".task-panel")).toBeNull()

    await userEvent.click(tab)
    expect(within(tab).queryByText("2")).toBeNull()
    expect(within(screen.getByTestId("bar-end")).getByRole("button", { name: "Pin task list" })).toBeInTheDocument()
    expect(await screen.findByText("task 1")).toBeInTheDocument()
  })

  it("unread task events: a dot on the Tasks tab while it is not active", async () => {
    wrap(2)
    const tab = screen.getByRole("tab", { name: /Tasks/ })
    expect(within(tab).getByRole("img", { name: "unread task activity" })).toBeInTheDocument()
    await userEvent.click(tab)
    expect(within(tab).queryByRole("img", { name: "unread task activity" })).toBeNull()
  })

  it("unread task events, pinned: the dot moves to the panel header", async () => {
    window.localStorage.setItem(TASK_LIST_KEY, JSON.stringify({ pinned: true }))
    wrap(1)
    const panel = document.querySelector(".task-panel") as HTMLElement
    expect(within(panel).getByRole("img", { name: "unread task activity" })).toBeInTheDocument()
  })

  it("no unread task events: no dot, tab or panel", async () => {
    wrap(0)
    expect(screen.queryByRole("img", { name: "unread task activity" })).toBeNull()
    act(() => {
      window.localStorage.setItem(TASK_LIST_KEY, JSON.stringify({ pinned: true }))
      window.dispatchEvent(new StorageEvent("storage", { key: TASK_LIST_KEY }))
    })
    expect(screen.queryByRole("img", { name: "unread task activity" })).toBeNull()
  })

  it("pinning moves the list into the panel and drops the tab; Unpin brings it back", async () => {
    wrap()
    await userEvent.click(screen.getByRole("tab", { name: /Tasks/ }))
    await userEvent.click(screen.getByRole("button", { name: "Pin task list" }))

    expect(screen.queryByRole("tab", { name: /Tasks/ })).toBeNull()
    // Fell back to Activity.
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true")
    const panel = document.querySelector(".task-panel") as HTMLElement
    expect(panel).not.toBeNull()
    expect(await within(panel).findByText("Tasks · 2 open")).toBeInTheDocument()
    expect(await within(panel).findByText("task 1")).toBeInTheDocument()

    await userEvent.click(within(panel).getByRole("button", { name: "Unpin task list" }))
    expect(document.querySelector(".task-panel")).toBeNull()
    expect(screen.getByRole("tab", { name: /Tasks/ })).toBeInTheDocument()
    // Stays on Activity: unpinning does not jump back.
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true")
  })

  it("the pinned list is capped by rows and by the viewport, and scrolls inside itself", async () => {
    window.localStorage.setItem(TASK_LIST_KEY, JSON.stringify({ pinned: true }))
    wrap()
    const panel = document.querySelector(".task-panel") as HTMLElement
    await within(panel).findByText("task 1")
    const body = within(panel).getByTestId("task-list-body")
    expect(body.style.maxHeight).toBe("min(240px, 25dvh)")
    expect(body).toHaveStyle({ overflowY: "auto" })
  })

  it("a pin from another tab or list also falls back", async () => {
    wrap()
    await userEvent.click(screen.getByRole("tab", { name: /Tasks/ }))
    act(() => {
      window.localStorage.setItem(TASK_LIST_KEY, JSON.stringify({ pinned: true }))
      window.dispatchEvent(new StorageEvent("storage", { key: TASK_LIST_KEY }))
    })
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true")
    expect(document.querySelector(".task-panel")).not.toBeNull()
  })
})

/** A Slack pane's shape: Thread, then Tasks, the unread count passed through. */
function ResourceHost({ unread }: { unread?: number }) {
  const [tab, setTab] = useState("thread")
  const { tasks, shownTab } = useResourceTasksPlacement({ type: "slack", id: "C1:1.2" }, tab, setTab, "thread", unread)
  return (
    <Tabs value={shownTab} onChange={(v) => v && setTab(v)}>
      <Tabs.List>
        <Tabs.Tab value="thread">Thread</Tabs.Tab>
        {tasks.tab}
      </Tabs.List>
    </Tabs>
  )
}

describe("useResourceTasksPlacement", () => {
  it("passes the resource's task unread through to the Tasks tab's dot", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <MantineProvider>
        <QueryClientProvider client={qc}><TaskModalProvider><ResourceHost unread={2} /></TaskModalProvider></QueryClientProvider>
      </MantineProvider>,
    )
    const tab = screen.getByRole("tab", { name: /Tasks/ })
    expect(within(tab).getByRole("img", { name: "unread task activity" })).toBeInTheDocument()
  })
})
