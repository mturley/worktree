import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskModalProvider } from "./tasks/modal/TaskModalProvider"
import type { TimelineEvent } from "../api/types"

const mocks = vi.hoisted(() => ({
  events: [] as TimelineEvent[],
  pick: null as { id: number; title: string; paths: string[] } | null,
}))
vi.mock("../hooks/useTimeline", () => ({
  useGlobalTimeline: () => ({
    events: mocks.events, isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false,
  }),
}))

import { useActivityPanel, type EventSelectMode } from "./ActivityPanel"
import { api } from "../api/client"

function Host({ select }: { select: EventSelectMode }) {
  const activity = useActivityPanel({ unreadOnly: false, setUnreadOnly: () => {}, hasUnread: false, select })
  return (
    <>
      {activity.render()}
      {activity.modals}
      <button type="button" onClick={() => activity.pickTask(mocks.pick!)}>pick task</button>
    </>
  )
}

const wrap = (select: EventSelectMode) => render(
  <QueryClientProvider client={new QueryClient()}>
    <MantineProvider><TaskModalProvider><Host select={select} /></TaskModalProvider></MantineProvider>
  </QueryClientProvider>,
)

const event: TimelineEvent = {
  id: "evt-1", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "github",
  type: "pr_comment", type_label: "", title: "Looks good to me", body: "Ship the gizmo", author: "someone",
  resource_type: "pr", resource_id: "o/r#1", resource_url: "https://gh/pr/1", resource_title: "Fix the widget",
  worktrees: ["my-branch"], worktree_paths: ["/wt/foo"],
}

beforeEach(() => {
  window.history.replaceState({}, "", "/mini")
  window.localStorage.clear()
  window.sessionStorage.clear()
  mocks.events = []
  vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
  vi.spyOn(api, "tasks").mockResolvedValue([])
  vi.spyOn(api, "allResources").mockResolvedValue([])
})
afterEach(() => vi.restoreAllMocks())
afterEach(cleanup)

describe("useActivityPanel select: details", () => {
  it("opens the event's details instead of routing to its worktree", async () => {
    mocks.events = [event]
    wrap("details")
    await userEvent.click(screen.getByText("Looks good to me"))
    const dialog = await screen.findByRole("dialog")
    // The body renders from a lazily loaded chunk.
    expect(await within(dialog).findByText("Ship the gizmo")).toBeInTheDocument()
    expect(window.location.pathname).toBe("/mini")
  })
})

describe("useActivityPanel: a task event's row", () => {
  const taskEvent = (worktree_paths: string[]): TimelineEvent => ({
    ...event, id: "task:7", source: "tasks", type: "task_created", title: "Created the task",
    resource_type: "task", resource_id: "12", resource_url: "", resource_title: "Write the docs",
    worktrees: worktree_paths.map((_, i) => `branch-${i}`), worktree_paths,
  })
  const home = (paths: string[]) => {
    window.history.replaceState({}, "", "/")
    mocks.events = [taskEvent(paths)]
    wrap("route")
  }

  it("goes to the task's worktree and opens the task there", async () => {
    home(["/wt/foo"])
    await userEvent.click(screen.getByText("Created the task"))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
    expect(window.location.search).toBe("?task=12")
  })

  it("asks which worktree when the task has several, then opens the task there", async () => {
    home(["/wt/foo", "/wt/bar"])
    await userEvent.click(screen.getByText("Created the task"))
    expect(window.location.pathname).toBe("/")
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Write the docs")).toBeInTheDocument()
    expect(within(dialog).getByText(/This task belongs to 2 worktrees/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole("button", { name: "view in bar" }))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/bar")}`)
    expect(window.location.search).toBe("?task=12")
  })

  it("opens a task with no worktree over the home page", async () => {
    home([])
    await userEvent.click(screen.getByText("Created the task"))
    expect(window.location.pathname).toBe("/")
    expect(window.location.search).toBe("?task=12")
  })

  it("stays on the page in details mode", async () => {
    mocks.events = [taskEvent(["/wt/foo"])]
    wrap("details")
    await userEvent.click(screen.getByText("Created the task"))
    expect(window.location.pathname).toBe("/mini")
    expect(window.location.search).toBe("?task=12")
  })
})

describe("useActivityPanel: a task picked in search", () => {
  const pick = async (select: EventSelectMode, paths: string[], at: string) => {
    window.history.replaceState({}, "", at)
    mocks.pick = { id: 12, title: "Write the docs", paths }
    wrap(select)
    await userEvent.click(screen.getByRole("button", { name: "pick task" }))
  }

  it("goes to its one worktree and opens there", async () => {
    await pick("route", ["/wt/foo"], "/")
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
    expect(window.location.search).toBe("?task=12")
  })

  it("asks which of several worktrees", async () => {
    await pick("route", ["/wt/foo", "/wt/bar"], "/")
    expect(window.location.pathname).toBe("/")
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Write the docs")).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole("button", { name: "view in foo" }))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
    expect(window.location.search).toBe("?task=12")
  })

  it("opens over the page when it has no worktree", async () => {
    await pick("route", [], "/")
    expect(window.location.pathname).toBe("/")
    expect(window.location.search).toBe("?task=12")
  })

  it("stays on the page in details mode", async () => {
    await pick("details", ["/wt/foo"], "/mini")
    expect(window.location.pathname).toBe("/mini")
    expect(window.location.search).toBe("?task=12")
  })
})
