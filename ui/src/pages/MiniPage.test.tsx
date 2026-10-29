import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Router } from "wouter"
import { TaskModalProvider } from "../components/tasks/modal/TaskModalProvider"
import { setTaskListPrefs } from "../hooks/useTaskListPrefs"
import { useMiniLocation } from "../lib/miniMode"
import type { Task, TimelineEvent, WorktreeSummary } from "../api/types"

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

  it("unreads only narrows the activity feed", async () => {
    wrap()
    expect(mocks.timelineArgs.at(-1)?.[2]).toBe(false)
    await userEvent.click(screen.getByRole("switch", { name: "Unreads only" }))
    expect(mocks.timelineArgs.at(-1)?.[2]).toBe(true)
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
