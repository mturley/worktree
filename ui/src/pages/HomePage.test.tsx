import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { act, render, cleanup, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { setViewport } from "../testing/viewport"
import { baseSettings } from "../components/settings/testSettings"
import type { TimelineEvent, WorktreeSummary } from "../api/types"

const summary: WorktreeSummary = {
  path: "/wt/foo", repo: "odh", branch: "my-branch",
  on_disk: true, resource_count: 1, primary_count: 1, latest_event_ts: "",
  primary_by_type: { pr: 1 }, related_count: 0,
  focus_resources: [{ type: "pr", id: "o/r#1", url: "https://gh/pr/1", primary: true, title: "Fix the widget", state: "OPEN" }],
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
  mocks.events = []
  vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
  vi.spyOn(api, "allResources").mockResolvedValue([
    { type: "pr", id: "o/r#9", url: "https://gh/pr/9", primary: true, title: "Theirs", state: "OPEN",
      worktrees: [{ path: "/wt/foo", repo: "odh", branch: "my-branch" }] },
  ])
})
afterEach(() => vi.restoreAllMocks())
afterEach(cleanup)

describe("HomePage responsive layout", () => {
  it("shows a Worktrees/Activity/Resources tab bar when narrow", () => {
    setViewport("narrow")
    wrap()
    expect(screen.getByRole("tab", { name: "Worktrees" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Activity" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Resources" })).toBeInTheDocument()
  })

  it("tabs only the right column, Activity and Resources, when wide", () => {
    setViewport("wide")
    wrap()
    expect(screen.queryByRole("tab", { name: "Worktrees" })).not.toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: "Resources" })).toBeInTheDocument()
  })

  it("swaps the activity feed for the resources list on the Resources tab", async () => {
    setViewport("wide")
    wrap()
    await userEvent.click(screen.getByRole("tab", { name: "Resources" }))
    expect(document.querySelector("[data-activity-header]")).toBeNull()
    expect(await screen.findByText("Theirs")).toBeInTheDocument()
    // The worktree list stays.
    expect(screen.getByText(/Fix the widget/)).toBeInTheDocument()
  })

  it("renders worktrees as cards with their focus resources in both layouts", () => {
    setViewport("wide")
    wrap()
    expect(screen.getByText(/my-branch/)).toBeInTheDocument()
    expect(screen.getByText(/Fix the widget/)).toBeInTheDocument()
  })
})

describe("HomePage pinned headers", () => {
  const isPinned = (el: Element | null) => (el as HTMLElement | null)?.style.position === "sticky"
  const headers = () => [
    document.querySelector("[data-worktrees-header]"),
    document.querySelector("[data-activity-header]"),
  ]

  it("scrolls each column on its own when wide, its header pinned atop it", () => {
    setViewport("wide")
    wrap()
    const [worktrees, activity] = headers()
    expect(isPinned(worktrees)).toBe(true)
    expect(isPinned(activity)).toBe(true)
    // The filters ride with the activity header.
    expect(activity).toContainElement(screen.getByRole("button", { name: /GitHub/i }))
    for (const h of [worktrees, activity]) {
      expect((h!.closest(".mantine-Grid-col") as HTMLElement).style.overflowY).toBe("auto")
    }
  })

  it("does not pin the headers when short", () => {
    setViewport("wide", { tall: false })
    wrap()
    expect(headers().some(isPinned)).toBe(false)
  })

  it("does not pin the activity header on a phone", () => {
    setViewport("narrow", { tall: true })
    wrap()
    expect(isPinned(document.querySelector("[data-activity-header]"))).toBe(false)
  })
})

describe("HomePage tab bar controls", () => {
  it("puts the active tab's controls in the tab bar, before Settings, when wide", async () => {
    setViewport("wide")
    wrap()
    const tablist = screen.getByRole("tablist")
    const archived = within(tablist).getByRole("switch", { name: "Show archived" })
    expect(within(tablist).getByRole("button", { name: "Settings" })).toBeInTheDocument()
    expect(within(tablist).queryByRole("combobox", { name: "Sort resources" })).toBeNull()
    expect(archived.compareDocumentPosition(within(tablist).getByRole("button", { name: "Settings" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await userEvent.click(screen.getByRole("tab", { name: "Resources" }))
    const bar = screen.getByRole("tablist")
    expect(within(bar).getByRole("combobox", { name: "Sort resources" })).toBeInTheDocument()
    expect(await within(bar).findByText("1 resource")).toBeInTheDocument()
    expect(within(bar).queryByRole("switch", { name: "Show archived" })).toBeNull()
  })

  it("keeps them out of the crowded tab bar when narrow", () => {
    setViewport("narrow")
    wrap()
    const tablist = screen.getByRole("tablist")
    expect(within(tablist).queryByRole("switch", { name: "Show archived", hidden: true })).toBeNull()
    expect(within(tablist).queryByRole("combobox", { name: "Sort resources", hidden: true })).toBeNull()
    expect(screen.getByRole("combobox", { name: "Sort resources", hidden: true })).toBeInTheDocument()
  })
})

describe("HomePage settings", () => {
  it("puts the Settings cog in the right column's tab bar when wide", () => {
    setViewport("wide")
    wrap()
    const cog = screen.getByRole("button", { name: "Settings" })
    expect(cog.closest("[role='tablist']")).not.toBeNull()
    // Pinned with the activity header, so it stays in reach.
    expect(cog.closest("[data-activity-header]")).not.toBeNull()
    expect(screen.queryByRole("button", { name: "Devices" })).not.toBeInTheDocument()
  })

  it("puts the Settings cog in the tab bar when narrow", () => {
    setViewport("narrow")
    wrap()
    const cog = screen.getByRole("button", { name: "Settings" })
    expect(cog.closest("[role='tablist']")).not.toBeNull()
    expect(screen.getAllByRole("button", { name: "Settings" })).toHaveLength(1)
  })

  it("opens the Settings modal", async () => {
    setViewport("wide")
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    wrap()
    await userEvent.click(screen.getByRole("button", { name: "Settings" }))
    expect(await screen.findByRole("tab", { name: "Devices" })).toBeInTheDocument()
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

  it("sits with the worktree list's controls, not the activity feed's, in both layouts", async () => {
    for (const width of ["narrow", "wide"] as const) {
      setViewport(width)
      wrap()
      // hidden: on narrow each lives in its own tab, and only one is selected.
      const archived = await screen.findByRole("switch", { name: "Show archived", hidden: true })
      const heading = screen.getByRole("heading", { name: "Worktrees", hidden: true })
      // The first: narrow, the Resources tab has its own after it.
      const toggle = screen.getAllByRole("switch", { name: "Unreads only", hidden: true })[0]
      expect(toggle.closest(".mantine-Group-root")).toContainElement(heading)
      expect(toggle.closest(".mantine-Group-root")).not.toContainElement(archived)
      expect(heading.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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

describe("HomePage activity entry click", () => {
  const event: TimelineEvent = {
    id: "evt-7", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "github",
    type: "pr_comment", type_label: "", title: "Looks good to me", body: "", author: "someone",
    resource_type: "pr", resource_id: "o/r#1", resource_url: "https://gh/pr/1", resource_title: "Fix the widget",
    worktrees: ["my-branch"], worktree_paths: ["/wt/foo"],
  }

  it("goes to the resource in its worktree, carrying the event to open its details", async () => {
    setViewport("wide")
    mocks.events = [event]
    wrap()
    await userEvent.click(screen.getByText("Looks good to me"))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
    expect(new URLSearchParams(window.location.search).get("resource")).toBe("pr:o/r#1")
    expect(window.history.state).toEqual({ openEvent: event })
  })
})
