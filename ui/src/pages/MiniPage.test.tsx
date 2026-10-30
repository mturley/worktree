import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Router } from "wouter"
import { TaskModalProvider } from "../components/tasks/modal/TaskModalProvider"
import { setTaskListPrefs } from "../hooks/useTaskListPrefs"
import { useMiniLocation } from "../lib/miniMode"
import type { AllResourceDTO, Task, TimelineEvent, WorktreeSummary } from "../api/types"

const summary: WorktreeSummary = {
  path: "/wt/foo", repo: "odh", branch: "my-branch",
  on_disk: true, resource_count: 0, primary_count: 0, latest_event_ts: "",
  primary_by_type: {}, related_count: 0, focus_resources: [],
}

const task: Task = {
  id: 1, ref: "T1", title: "Write the docs", description: "", state: "not_started", priority: "none", starred: false,
  rank: "r1", created_at: "", updated_at: "", archived: false, links: [], implicit_worktrees: [],
  subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, open_blockers: [],
}

const event: TimelineEvent = {
  id: "evt-1", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "github",
  type: "pr_review_comment", type_label: "", title: "Looks good to me", body: "Ship the gizmo", author: "someone",
  resource_type: "pr", resource_id: "o/r#1", resource_url: "https://gh/pr/1", resource_title: "Fix the widget",
  worktrees: ["my-branch"], worktree_paths: ["/wt/foo"],
}

const mocks = vi.hoisted(() => ({
  worktrees: [] as WorktreeSummary[], timelineArgs: [] as unknown[][], events: [] as TimelineEvent[],
}))
vi.mock("../hooks/useWorktrees", () => ({ useWorktrees: () => ({ data: mocks.worktrees }) }))
vi.mock("../hooks/useTimeline", () => ({
  useGlobalTimeline: (...args: unknown[]) => {
    mocks.timelineArgs.push(args)
    return { events: mocks.events, isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false }
  },
}))

import { MiniPage } from "./MiniPage"
import { api } from "../api/client"

const wrap = () => render(
  <QueryClientProvider client={new QueryClient()}>
    <MantineProvider>
      <Router hook={useMiniLocation}><TaskModalProvider><MiniPage /></TaskModalProvider></Router>
    </MantineProvider>
  </QueryClientProvider>,
)

const post = vi.fn()
const stubBridge = () => {
  window.webkit = { messageHandlers: { worktree: { postMessage: post } } }
}

beforeEach(() => {
  window.history.replaceState({}, "", "/mini")
  window.localStorage.clear()
  window.sessionStorage.clear()
  post.mockReset()
  mocks.worktrees = [summary]
  mocks.timelineArgs = []
  mocks.events = []
  vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
  vi.spyOn(api, "tasks").mockResolvedValue([task])
  vi.spyOn(api, "allResources").mockResolvedValue([])
})
afterEach(() => {
  delete window.webkit
  vi.restoreAllMocks()
  cleanup()
})

describe("MiniPage", () => {
  it("renders Tasks and Activity tabs", () => {
    wrap()
    expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute("aria-selected", "false")
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true")
  })

  it("the Activity tab wears the worktree cards' unread badge", () => {
    mocks.worktrees = [{ ...summary, has_unread: true, unread_count: 3 }]
    wrap()
    expect(within(screen.getByRole("tab", { name: /Activity/ })).getByText("3 unreads")).toBeInTheDocument()
  })

  it("unreads only narrows the activity feed", async () => {
    wrap()
    expect(mocks.timelineArgs.at(-1)?.[2]).toBe(false)
    await userEvent.click(screen.getByRole("switch", { name: "Unreads only" }))
    expect(mocks.timelineArgs.at(-1)?.[2]).toBe(true)
  })

  it("U toggles unreads only", async () => {
    wrap()
    const toggle = screen.getByRole("switch", { name: "Unreads only" })
    expect(toggle).not.toBeChecked()
    await userEvent.keyboard("u")
    expect(toggle).toBeChecked()
    expect(mocks.timelineArgs.at(-1)?.[2]).toBe(true)
  })

  it("R opens the Mark all read preview", async () => {
    vi.spyOn(api, "allResources").mockResolvedValue([
      { type: "pr", id: "o/r#1", url: "u", primary: true, unread_count: 2, unread_through_ts: "2099-01-01T00:00:00Z", worktrees: [] } as AllResourceDTO,
    ])
    vi.spyOn(api, "taskUnread").mockResolvedValue([])
    wrap()
    await screen.findByRole("button", { name: /Mark all read/ })
    await userEvent.keyboard("r")
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("/ focuses the search, typing narrows the feed, and Esc clears it", async () => {
    wrap()
    const input = screen.getByRole("searchbox")
    await userEvent.keyboard("/")
    expect(input).toHaveFocus()
    await userEvent.keyboard("widget")
    await waitFor(() => expect(mocks.timelineArgs.at(-1)?.[4]).toBe("widget"))
    expect(window.location.pathname).toBe("/mini")
    await userEvent.keyboard("{Escape}")
    expect(input).toHaveValue("")
  })

  it("search suggestions fill the window, and the page behind holds still", async () => {
    wrap()
    const input = screen.getByRole("searchbox")
    await userEvent.type(input, "my")
    const box = await screen.findByTestId("search-suggestions")
    expect(box).toHaveStyle({ position: "fixed", bottom: "var(--mantine-spacing-xs)" })
    expect(within(box).getByRole("listbox")).toHaveStyle({ overscrollBehavior: "contain" })
    expect(document.documentElement.style.overflow).toBe("hidden")
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByTestId("search-suggestions")).not.toBeInTheDocument())
    expect(document.documentElement.style.overflow).toBe("")
  })

  it("a worktree suggestion opens the full UI outside", async () => {
    stubBridge()
    wrap()
    await userEvent.type(screen.getByRole("searchbox"), "my-branch")
    await userEvent.keyboard("{ArrowDown}{Enter}")
    await waitFor(() => expect(post).toHaveBeenCalledWith({
      type: "open", url: `${window.location.origin}/worktree/${encodeURIComponent("/wt/foo")}`,
    }))
    expect(window.location.pathname).toBe("/mini")
  })

  it("Esc closes the dropdown only when it has nothing else to do", async () => {
    stubBridge()
    mocks.events = [event]
    vi.spyOn(api, "locatePRComment").mockRejectedValue(new Error("404"))
    wrap()
    const closes = () => post.mock.calls.filter(([m]) => m.type === "close").length

    // An open modal takes Esc first.
    await userEvent.click(screen.getByText("Looks good to me"))
    await screen.findByRole("dialog")
    await userEvent.keyboard("{Escape}")
    expect(closes()).toBe(0)
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

    // Then the search and Unreads only, cleared together.
    await userEvent.keyboard("u")
    expect(screen.getByRole("switch", { name: "Unreads only" })).toBeChecked()
    await userEvent.keyboard("{Escape}")
    expect(closes()).toBe(0)
    expect(screen.getByRole("switch", { name: "Unreads only" })).not.toBeChecked()

    // With nothing left, the dropdown.
    await userEvent.keyboard("{Escape}")
    expect(closes()).toBe(1)
  })

  it("Esc on the Tasks tab goes back to Activity before closing the dropdown", async () => {
    stubBridge()
    wrap()
    const closes = () => post.mock.calls.filter(([m]) => m.type === "close").length
    const activityTab = () => screen.getByRole("tab", { name: /Activity/ })

    await userEvent.click(screen.getByRole("tab", { name: "Tasks" }))
    expect(within(activityTab()).getByText("Esc")).toBeInTheDocument()

    // Clearing comes first; the hint waits for it.
    await userEvent.keyboard("u")
    expect(within(activityTab()).queryByText("Esc")).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute("aria-selected", "true")

    await userEvent.keyboard("{Escape}")
    expect(closes()).toBe(0)
    expect(activityTab()).toHaveAttribute("aria-selected", "true")
    expect(within(activityTab()).queryByText("Esc")).not.toBeInTheDocument()

    await userEvent.keyboard("{Escape}")
    expect(closes()).toBe(1)
  })

  it("tasks tab ignores collapsed", async () => {
    setTaskListPrefs({ collapsed: true })
    wrap()
    await userEvent.click(screen.getByRole("tab", { name: "Tasks" }))
    expect(await screen.findByText("Write the docs")).toBeInTheDocument()
  })

  it("clicking an event opens its details in place", async () => {
    stubBridge()
    mocks.events = [event]
    vi.spyOn(api, "locatePRComment").mockRejectedValue(new Error("404"))
    wrap()
    post.mockClear()
    await userEvent.click(screen.getByText("Looks good to me"))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Ship the gizmo")).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
  })

  it("an event row's tooltip says it opens details here, not in a worktree", async () => {
    mocks.events = [event]
    wrap()
    await userEvent.hover(screen.getByText("Looks good to me"))
    expect(await screen.findByText("View event details")).toBeInTheDocument()
    expect(screen.queryByText("View event details in worktree")).not.toBeInTheDocument()
  })

  it("event details buttons open the browser", async () => {
    stubBridge()
    mocks.events = [event]
    vi.spyOn(api, "locatePRComment").mockResolvedValue({ path: "/wt/foo", comment_id: 7 })
    wrap()
    await userEvent.click(screen.getByText("Looks good to me"))
    await userEvent.click(await screen.findByRole("button", { name: "Go to comment in diff view" }))
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "open" }))
    const url = post.mock.calls.find(([m]) => m.type === "open")![0].url as string
    expect(url).toContain("/worktree/")
    expect(window.location.pathname).toBe("/mini")
  })

  it("open full UI posts open", async () => {
    stubBridge()
    wrap()
    await userEvent.click(screen.getByRole("button", { name: /Open full UI/ }))
    expect(post).toHaveBeenCalledWith({ type: "open", url: window.location.origin + "/" })
  })

  it("posts ready on mount", async () => {
    stubBridge()
    wrap()
    await waitFor(() => expect(post).toHaveBeenCalledWith({ type: "ready" }))
  })
})
