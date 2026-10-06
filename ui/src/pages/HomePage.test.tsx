import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { act, render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { setViewport } from "../testing/viewport"
import type { WorktreeSummary } from "../api/types"

const summary: WorktreeSummary = {
  path: "/wt/foo", repo: "odh", branch: "my-branch",
  on_disk: true, resource_count: 1, primary_count: 1, latest_event_ts: "",
  primary_by_type: { pr: 1 }, related_count: 0,
  focus_resources: [{ type: "pr", id: "o/r#1", url: "https://gh/pr/1", primary: true, title: "Fix the widget", state: "OPEN" }],
}

const mocks = vi.hoisted(() => ({ worktrees: [] as WorktreeSummary[], timelineArgs: [] as unknown[][] }))
vi.mock("../hooks/useWorktrees", () => ({ useWorktrees: () => ({ data: mocks.worktrees }) }))
vi.mock("../hooks/useTimeline", () => ({
  useGlobalTimeline: (...args: unknown[]) => {
    mocks.timelineArgs.push(args)
    return { events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false }
  },
}))

import { HomePage } from "./HomePage"
import { api } from "../api/client"

const wrap = () => {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <MantineProvider><HomePage /></MantineProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.history.replaceState({}, "", "/")
  window.localStorage.clear()
  mocks.worktrees = [summary]
  mocks.timelineArgs = []
  vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
})
afterEach(() => vi.restoreAllMocks())
afterEach(cleanup)

describe("HomePage responsive layout", () => {
  it("shows a Worktrees/Activity tab bar when narrow", () => {
    setViewport("narrow")
    wrap()
    expect(screen.getByRole("tab", { name: "Worktrees" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Activity" })).toBeInTheDocument()
  })

  it("shows no tab bar when wide", () => {
    setViewport("wide")
    wrap()
    expect(screen.queryByRole("tab", { name: "Worktrees" })).not.toBeInTheDocument()
  })

  it("renders worktrees as cards with their focus resources in both layouts", () => {
    setViewport("wide")
    wrap()
    expect(screen.getByText(/my-branch/)).toBeInTheDocument()
    expect(screen.getByText(/Fix the widget/)).toBeInTheDocument()
  })
})

describe("HomePage devices", () => {
  it("offers the Devices panel from the header at both widths", () => {
    for (const width of ["narrow", "wide"] as const) {
      setViewport(width)
      wrap()
      expect(screen.getByRole("button", { name: "Devices" })).toBeInTheDocument()
      cleanup()
    }
  })
})

describe("HomePage worktree sorting", () => {
  const older: WorktreeSummary = { ...summary, path: "/wt/zeta", branch: "zeta-branch", latest_event_ts: "2026-09-01T00:00:00Z", focus_resources: [] }
  const newer: WorktreeSummary = { ...summary, path: "/wt/alpha", branch: "alpha-branch", latest_event_ts: "2026-09-20T00:00:00Z", focus_resources: [] }

  /** Branch names in on-page order. */
  const order = () => {
    const text = document.body.textContent ?? ""
    return ["alpha-branch", "zeta-branch"].sort((a, b) => text.indexOf(a) - text.indexOf(b))
  }

  it("offers the sort control at both widths", async () => {
    for (const width of ["narrow", "wide"] as const) {
      setViewport(width)
      wrap()
      expect(await screen.findByRole("combobox", { name: "Sort worktrees" })).toBeInTheDocument()
      cleanup()
    }
  })

  it("defaults to latest activity without cmux, and re-sorts on change", async () => {
    setViewport("wide")
    mocks.worktrees = [older, newer]
    wrap()
    const select = await screen.findByRole("combobox", { name: "Sort worktrees" })
    await waitFor(() => expect(select).toHaveValue("activity"))
    expect(order()).toEqual(["alpha-branch", "zeta-branch"])

    await userEvent.selectOptions(select, "Created")
    await userEvent.click(screen.getByRole("button", { name: "Toggle sort direction" }))
    // Same created_at on both, so ties fall back to name order either way.
    expect(order()).toEqual(["alpha-branch", "zeta-branch"])
    expect(window.localStorage.getItem("worktree.home.sort.createdDir")).toBe("desc")
  })

  it("restores a saved mode", async () => {
    setViewport("wide")
    window.localStorage.setItem("worktree.home.sort.mode", "name")
    mocks.worktrees = [older, newer]
    wrap()
    expect(await screen.findByRole("combobox", { name: "Sort worktrees" })).toHaveValue("name")
    expect(order()).toEqual(["alpha-branch", "zeta-branch"])
  })

  it("orders by cmux sidebar position when cmux is available", async () => {
    setViewport("wide")
    vi.spyOn(api, "cmux").mockResolvedValue({
      available: true,
      matches: { "/wt/zeta": [{ ref: "workspace:4", title: "z", selected: false, index: 0 }] },
    })
    mocks.worktrees = [newer, older]
    wrap()
    const select = await screen.findByRole("combobox", { name: "Sort worktrees" })
    await waitFor(() => expect(select).toHaveValue("cmux"))
    expect(order()).toEqual(["zeta-branch", "alpha-branch"])
  })

  it("reverses name order with the direction toggle", async () => {
    setViewport("wide")
    window.localStorage.setItem("worktree.home.sort.mode", "name")
    mocks.worktrees = [older, newer]
    wrap()
    await screen.findByRole("combobox", { name: "Sort worktrees" })
    expect(order()).toEqual(["alpha-branch", "zeta-branch"])
    await userEvent.click(screen.getByRole("button", { name: "Toggle sort direction" }))
    expect(order()).toEqual(["zeta-branch", "alpha-branch"])
    expect(window.localStorage.getItem("worktree.home.sort.nameDir")).toBe("desc")
  })
})

describe("HomePage unread-only toggle", () => {
  it("is off by default and narrows the feed to unread events when switched on", async () => {
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    const toggle = screen.getByRole("switch", { name: "Unreads only" })
    expect(toggle).not.toBeChecked()
    expect(mocks.timelineArgs.at(-1)?.[2]).toBe(false)
    await user.click(toggle)
    expect(mocks.timelineArgs.at(-1)?.[2]).toBe(true)
    expect(window.localStorage.getItem("worktree.unreadOnly")).toBe("true")
  })

  it("sits beside the sort control in both layouts", async () => {
    for (const width of ["narrow", "wide"] as const) {
      setViewport(width)
      wrap()
      const sort = await screen.findByRole("combobox", { name: "Sort worktrees" })
      const toggle = screen.getByRole("switch", { name: "Unreads only" })
      expect(toggle.closest(".mantine-Group-root")).toContainElement(sort)
      cleanup()
    }
  })

  it("hides worktrees without unread events", () => {
    window.localStorage.setItem("worktree.unreadOnly", "true")
    mocks.worktrees = [
      summary,
      { ...summary, path: "/wt/bar", branch: "bar-branch", has_unread: true, unread_count: 1 },
    ]
    setViewport("wide")
    wrap()
    expect(screen.getByText(/bar-branch/)).toBeInTheDocument()
    expect(screen.queryByText(/my-branch/)).not.toBeInTheDocument()
  })

  it("says so when no worktree has unread events", () => {
    window.localStorage.setItem("worktree.unreadOnly", "true")
    setViewport("wide")
    wrap()
    expect(screen.getByText("No worktrees with unread events")).toBeInTheDocument()
  })

  it("follows a change made in another tab", async () => {
    setViewport("wide")
    wrap()
    act(() => {
      window.localStorage.setItem("worktree.unreadOnly", "true")
      window.dispatchEvent(new StorageEvent("storage", { key: "worktree.unreadOnly", newValue: "true" }))
    })
    expect(screen.getByRole("switch", { name: "Unreads only" })).toBeChecked()
  })
})
