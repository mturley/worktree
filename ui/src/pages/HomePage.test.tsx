import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { act, fireEvent, render, cleanup, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { TaskModalProvider } from "../components/tasks/modal/TaskModalProvider"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { setViewport } from "../testing/viewport"
import { baseSettings } from "../components/settings/testSettings"
import type { Task, TimelineEvent, WorktreeSummary } from "../api/types"
import { TASK_LIST_KEY } from "../lib/taskListPrefs"

const summary: WorktreeSummary = {
  path: "/wt/foo", repo: "odh", branch: "my-branch",
  on_disk: true, resource_count: 1, primary_count: 1, latest_event_ts: "",
  primary_by_type: { pr: 1 }, related_count: 0,
  focus_resources: [{ type: "pr", id: "o/r#1", url: "https://gh/pr/1", primary: true, title: "Fix the widget", state: "OPEN" }],
}

const homeTask: Task = {
  id: 1, ref: "T1", title: "Write the docs", description: "", state: "not_started", priority: "none", starred: false,
  rank: "r1", created_at: "", updated_at: "", archived: false, links: [], implicit_worktrees: [],
  subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, blocker_labels: [],
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
      <MantineProvider><TaskModalProvider><HomePage /></TaskModalProvider></MantineProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.history.replaceState({}, "", "/")
  window.localStorage.clear()
  window.sessionStorage.clear()
  mocks.worktrees = [summary]
  mocks.timelineArgs = []
  mocks.events = []
  vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
  vi.spyOn(api, "tasks").mockResolvedValue([homeTask])
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
    within(tablist).getByRole("switch", { name: "Show archived" })
    // Settings lives in the page header now, not the tab bar.
    expect(within(tablist).queryByRole("button", { name: "Settings" })).toBeNull()
    expect(within(tablist).queryByRole("combobox", { name: "Sort resources" })).toBeNull()

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
  it("puts the Settings cog in the page header at both widths", () => {
    for (const width of ["wide", "narrow"] as const) {
      setViewport(width)
      wrap()
      const cog = screen.getByRole("button", { name: "Settings" })
      expect(cog.closest("[data-testid='home-header']")).not.toBeNull()
      expect(cog.closest("[role='tablist']")).toBeNull()
      expect(screen.getAllByRole("button", { name: "Settings" })).toHaveLength(1)
      cleanup()
    }
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

describe("HomePage Esc", () => {
  it("goes to the tab's home worktree with nothing to clear", async () => {
    window.history.replaceState({}, "", `/?home=${encodeURIComponent("/wt/home")}`)
    setViewport("wide")
    wrap()
    fireEvent.keyDown(document.body, { key: "Escape" })
    await waitFor(() => expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/home")}`))
  })

  it("stays put when the home banner was dismissed, as if unhomed", () => {
    window.history.replaceState({}, "", `/?home=${encodeURIComponent("/wt/home")}`)
    window.sessionStorage.setItem("worktree.banner.dismissed.home", "1")
    setViewport("wide")
    wrap()
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(window.location.pathname).toBe("/")
  })

  it("stays put with nothing to clear and no home worktree", () => {
    setViewport("wide")
    wrap()
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(window.location.pathname).toBe("/")
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

  it("sits in the page header, not the worktree list's or activity feed's controls, in both layouts", () => {
    for (const width of ["narrow", "wide"] as const) {
      setViewport(width)
      wrap()
      const header = screen.getByTestId("home-header")
      expect(within(header).getByRole("heading", { name: "Worktrees" })).toBeInTheDocument()
      expect(within(header).getByRole("switch", { name: "Unreads only" })).toBeInTheDocument()
      expect(screen.getAllByRole("switch", { name: "Unreads only", hidden: true })).toHaveLength(1)
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

  it("lists only a card's unread resources, related ones included", async () => {
    window.localStorage.setItem("worktree.unreadOnly", "true")
    const wt = { path: "/wt/foo", repo: "odh", branch: "my-branch" }
    mocks.worktrees = [{
      ...summary, has_unread: true, unread_count: 2, related_count: 2, related_by_type: { slack: 1, jira: 1 },
      focus_resources: [
        { type: "pr", id: "o/r#1", url: "", primary: true, title: "Fix the widget" },
        { type: "pr", id: "o/r#2", url: "", primary: true, title: "Unread focus", unread_count: 1 },
      ],
    }]
    vi.spyOn(api, "allResources").mockResolvedValue([
      { type: "slack", id: "C1:1", url: "", primary: false, title: "Unread related", has_unread: true, worktrees: [wt] },
      { type: "jira", id: "J-1", url: "", primary: false, title: "Read related", worktrees: [wt] },
    ])
    setViewport("wide")
    wrap()
    expect(await screen.findByText("Unread related")).toBeInTheDocument()
    expect(screen.getByText("Unread focus")).toBeInTheDocument()
    expect(screen.queryByText("Fix the widget")).not.toBeInTheDocument()
    expect(screen.queryByText("Read related")).not.toBeInTheDocument()
    expect(screen.queryByText(/^\+ /)).not.toBeInTheDocument()
  })

  it("Esc turns Unreads only off as well as clearing the search", async () => {
    window.localStorage.setItem("worktree.unreadOnly", "true")
    window.history.replaceState({}, "", "/?q=kumquat")
    setViewport("wide")
    wrap()
    expect(screen.getByRole("switch", { name: "Unreads only" })).toBeChecked()
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.getByRole("switch", { name: "Unreads only" })).not.toBeChecked()
    expect(new URLSearchParams(window.location.search).has("q")).toBe(false)
  })

  it("Esc turns Unreads only off with no search at all", () => {
    window.localStorage.setItem("worktree.unreadOnly", "true")
    setViewport("wide")
    wrap()
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.getByRole("switch", { name: "Unreads only" })).not.toBeChecked()
  })

  it("heads each pane with what Unreads only leaves, with no search", async () => {
    window.localStorage.setItem("worktree.unreadOnly", "true")
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    const lines = () => screen.getAllByTestId("search-summary").map((n) => n.textContent)
    expect(lines()).toContain("0 worktrees with unread events. See everything Esc")
    await waitFor(() => expect(lines()).toContain("0 unread events. See everything Esc"))
    // The line says it: no empty-list text under it.
    expect(screen.queryByText(/No worktrees with unread events/)).toBeNull()
    expect(screen.queryByText(/No unread events/)).toBeNull()
    await user.click(screen.getByRole("tab", { name: /Resources/ }))
    expect(lines()).toContain("0 resources with unread events. See everything Esc")
    expect(screen.queryByText(/No unread resources/)).toBeNull()
  })

  it("See everything turns Unreads only off, and the lines go", async () => {
    window.localStorage.setItem("worktree.unreadOnly", "true")
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getAllByRole("button", { name: "See everything" })[0])
    expect(screen.getByRole("switch", { name: "Unreads only" })).not.toBeChecked()
    expect(screen.getByText(/my-branch/)).toBeInTheDocument()
    expect(screen.queryByTestId("search-summary")).toBeNull()
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

  it("asks which worktree when several follow the event's resource", async () => {
    setViewport("wide")
    const shared = { ...event, worktrees: ["my-branch", "other-branch"], worktree_paths: ["/wt/foo", "/wt/bar"] }
    mocks.events = [shared]
    wrap()
    await userEvent.click(screen.getByText("Looks good to me"))
    expect(window.location.pathname).toBe("/")
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Fix the widget")).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole("button", { name: "view in other-branch" }))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/bar")}`)
    expect(window.history.state).toEqual({ openEvent: shared })
  })
})

describe("HomePage search", () => {
  it("filters worktrees and resources, passes q to the feed, shows counts", async () => {
    setViewport("wide")
    mocks.worktrees = [summary, { ...summary, path: "/wt/bar", branch: "kumquat-branch", focus_resources: [] }]
    window.history.replaceState({}, "", "/?q=kumquat")
    wrap()
    expect(screen.getByRole("searchbox")).toHaveValue("kumquat")
    expect(screen.queryByText(/my-branch/)).toBeNull()
    expect(screen.getAllByText(/kumquat/i).length).toBeGreaterThan(0)
    // Debounced value reaches the feed hook as its 5th argument.
    await waitFor(() => expect(mocks.timelineArgs.at(-1)?.[4]).toBe("kumquat"))
  })

  it("clearing restores everything and removes q", async () => {
    setViewport("wide")
    window.history.replaceState({}, "", "/?q=zzzz")
    wrap()
    expect(screen.getAllByTestId("search-summary").map((n) => n.textContent))
      .toContain("0 worktrees match your search. Clear search Esc")
    // The 0 line says it: no empty-list text under it.
    expect(screen.queryByText(/Nothing matches/)).toBeNull()
    expect(screen.queryByText(/No worktrees/)).toBeNull()
    await userEvent.click(within(screen.getByTestId("home-header")).getByRole("button", { name: "Clear search" }))
    expect(screen.getByText(/my-branch/)).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).has("q")).toBe(false)
    await waitFor(() => expect(mocks.timelineArgs.at(-1)?.[4] ?? "").toBe(""))
  })

  it("does not match a card through a resource the source filter excludes", async () => {
    setViewport("wide")
    vi.spyOn(api, "allResources").mockResolvedValue([
      { type: "jira", id: "J-5", url: "u", primary: false, title: "Unrelated", assignee: "Pat Kumquat",
        worktrees: [{ path: "/wt/foo", repo: "odh", branch: "my-branch" }] },
    ])
    window.history.replaceState({}, "", "/?q=kumquat")
    wrap()
    expect(await screen.findByText(/my-branch/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /GitHub/ }))
    await waitFor(() => expect(screen.queryByText(/my-branch/)).toBeNull())
  })

  it("heads each pane with its match count and a way to clear the search", async () => {
    setViewport("wide")
    mocks.worktrees = [summary, { ...summary, path: "/wt/bar", branch: "kumquat-branch", focus_resources: [] }]
    mocks.events = [{
      id: "evt-1", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "github",
      type: "pr_comment", type_label: "", title: "Kumquat remark", body: "", author: "someone",
      resource_type: "pr", resource_id: "o/r#1", resource_url: "https://gh/pr/1", resource_title: "", worktrees: ["my-branch"],
      worktree_paths: ["/wt/foo"],
    }]
    window.history.replaceState({}, "", "/?q=kumquat")
    const user = userEvent.setup()
    wrap()
    const lines = () => screen.getAllByTestId("search-summary").map((n) => n.textContent)
    expect(lines()).toContain("1 worktree matches your search. Clear search Esc")
    // The feed's line waits for the debounced query to reach the server.
    await waitFor(() => expect(lines()).toContain("1 event matches your search. Clear search Esc"))
    await user.click(screen.getByRole("tab", { name: /Resources/ }))
    expect(lines()).toContain("0 resources match your search. Clear search Esc")
    await user.click(screen.getAllByRole("button", { name: "Clear search" }).at(-1)!)
    expect(screen.queryByTestId("search-summary")).toBeNull()
    expect(new URLSearchParams(window.location.search).has("q")).toBe(false)
  })

  it("puts each match line directly above its results, below the filters", async () => {
    setViewport("wide")
    mocks.events = [{
      id: "evt-1", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "github",
      type: "pr_comment", type_label: "", title: "Kumquat remark", body: "", author: "someone",
      resource_type: "pr", resource_id: "o/r#1", resource_url: "https://gh/pr/1", resource_title: "", worktrees: [],
    }]
    window.history.replaceState({}, "", "/?q=kumquat")
    const user = userEvent.setup()
    wrap()
    const after = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    const line = () => screen.getAllByTestId("search-summary").at(-1)!
    await waitFor(() => expect(line().textContent).toMatch(/event/))
    const activityHeader = document.querySelector<HTMLElement>("[data-activity-header]")!
    expect(after(within(activityHeader).getByRole("button", { name: /GitHub/ }), line())).toBe(true)
    await user.click(screen.getByRole("tab", { name: /Resources/ }))
    const typeToggle = within(screen.getByTestId("resources-header")).getByRole("button", { name: /Jira/ })
    expect(after(typeToggle, line())).toBe(true)
  })

  it("says when the match lines count only unread things", async () => {
    setViewport("wide")
    window.history.replaceState({}, "", "/?q=kumquat")
    const user = userEvent.setup()
    wrap()
    const lines = () => screen.getAllByTestId("search-summary").map((n) => n.textContent)
    await user.click(screen.getByRole("switch", { name: "Unreads only" }))
    expect(lines()).toContain("0 worktrees with unread events match your search. See everything Esc")
    await waitFor(() => expect(lines()).toContain("0 unread events match your search. See everything Esc"))
    await user.click(screen.getByRole("tab", { name: /Resources/ }))
    expect(lines()).toContain("0 resources with unread events match your search. See everything Esc")
  })

  it("shows no match line without a search", () => {
    setViewport("wide")
    wrap()
    expect(screen.queryByTestId("search-summary")).toBeNull()
  })

  it("a source filter heads the worktrees and the feed with 'match your filters'", async () => {
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    expect(screen.queryByTestId("search-summary")).toBeNull()
    await user.click(within(document.querySelector<HTMLElement>("[data-activity-header]")!).getByRole("button", { name: /GitHub/ }))
    expect(mocks.timelineArgs.at(-1)?.[1]).toEqual(["pr"])
    const lines = () => screen.getAllByTestId("search-summary").map((n) => n.textContent)
    expect(lines()).toContain("1 worktree matches your filters. Clear filters Esc")
    expect(lines()).toContain("0 events match your filters. Clear filters Esc")
    // The line's link clears them.
    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0])
    expect(mocks.timelineArgs.at(-1)?.[1]).toEqual([])
    expect(screen.queryByTestId("search-summary")).toBeNull()
  })

  it("a resource filter heads the Resources tab, and Esc clears it", async () => {
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getByRole("tab", { name: /Resources/ }))
    expect(await screen.findByText("Theirs")).toBeInTheDocument()
    await user.click(within(screen.getByTestId("resources-header")).getByRole("button", { name: /Jira/ }))
    expect(screen.queryByText("Theirs")).toBeNull()
    expect(screen.getAllByTestId("search-summary").map((n) => n.textContent))
      .toContain("0 resources match your filters. Clear filters Esc")
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.getByText("Theirs")).toBeInTheDocument()
    expect(screen.queryByTestId("search-summary")).toBeNull()
  })

  it("search and filters: 'match your search and filters', See everything, and Esc clears both", async () => {
    setViewport("wide")
    window.history.replaceState({}, "", "/?q=my")
    const user = userEvent.setup()
    wrap()
    await user.click(within(document.querySelector<HTMLElement>("[data-activity-header]")!).getByRole("button", { name: /GitHub/ }))
    expect(screen.getAllByTestId("search-summary").map((n) => n.textContent))
      .toContain("1 worktree matches your search and filters. See everything Esc")
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(new URLSearchParams(window.location.search).has("q")).toBe(false)
    expect(mocks.timelineArgs.at(-1)?.[1]).toEqual([])
  })

  it("moves global controls into the header", () => {
    setViewport("wide")
    wrap()
    const header = screen.getByTestId("home-header")
    expect(within(header).getByRole("searchbox")).toBeInTheDocument()
    expect(within(screen.getByTestId("worktrees-toolbar")).queryByText(/unread/i)).toBeNull()
  })

  it("opens the details dialog for a picked archived event", async () => {
    setViewport("wide")
    mocks.events = [{
      id: "evt-9", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "github",
      type: "pr_comment", type_label: "", title: "Zucchini remark", body: "", author: "someone",
      resource_type: "pr", resource_id: "o/r#2", resource_url: "https://gh/pr/2", resource_title: "Gone PR", worktrees: [],
    }]
    window.history.replaceState({}, "", "/?q=zucchini")
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getByRole("searchbox"))
    // Labeled as the activity list labels it.
    expect(within(screen.getByRole("listbox")).getByText("Archived")).toBeInTheDocument()
    await user.keyboard("{ArrowDown}{Enter}")
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("asks which worktree for a picked resource several worktrees follow", async () => {
    setViewport("wide")
    mocks.worktrees = [summary, { ...summary, path: "/wt/bar", branch: "other-branch", focus_resources: [] }]
    vi.spyOn(api, "allResources").mockResolvedValue([
      { type: "pr", id: "o/r#3", url: "https://gh/pr/3", primary: true, title: "Persimmon PR", state: "OPEN",
        worktrees: [{ path: "/wt/foo", repo: "odh", branch: "my-branch" }, { path: "/wt/bar", repo: "odh", branch: "other-branch" }] },
    ])
    window.history.replaceState({}, "", "/?q=persimmon")
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getByRole("searchbox"))
    // Highlighting splits the text, so find the option by its whole content.
    await waitFor(() => expect(within(screen.getByRole("listbox")).getAllByRole("option").some((o) => o.textContent?.includes("Persimmon PR"))).toBe(true))
    await user.click(within(screen.getByRole("listbox")).getAllByRole("option").find((o) => o.textContent?.includes("Persimmon PR"))!)
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "view in other-branch" }))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/bar")}`)
    expect(new URLSearchParams(window.location.search).get("resource")).toBe("pr:o/r#3")
  })

  it("asks which worktree for a picked event several worktrees follow", async () => {
    setViewport("wide")
    const shared: TimelineEvent = {
      id: "evt-4", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "github",
      type: "pr_comment", type_label: "", title: "Quince remark", body: "", author: "someone",
      resource_type: "pr", resource_id: "o/r#4", resource_url: "https://gh/pr/4", resource_title: "Shared PR",
      worktrees: ["my-branch", "other-branch"], worktree_paths: ["/wt/foo", "/wt/bar"],
    }
    mocks.events = [shared]
    window.history.replaceState({}, "", "/?q=quince")
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getByRole("searchbox"))
    await user.click(within(screen.getByRole("listbox")).getAllByRole("option").find((o) => o.textContent?.includes("Quince remark"))!)
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "view in other-branch" }))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/bar")}`)
    expect(window.history.state).toEqual({ openEvent: shared })
  })

  it("suggests a worktree by its cmux workspace name, shown above it", async () => {
    setViewport("wide")
    vi.spyOn(api, "cmux").mockResolvedValue({
      available: true,
      matches: { "/wt/foo": [{ ref: "workspace:1", title: "Persimmon workspace", color: "#ff0000", selected: false }] },
    })
    window.history.replaceState({}, "", "/?q=persimmon")
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getByRole("searchbox"))
    const list = await screen.findByRole("listbox")
    const row = within(list).getAllByRole("option")[0]
    // The match is highlighted, which splits the title across elements.
    await waitFor(() => expect(row.textContent).toContain("Persimmon workspace"))
    expect(row.querySelector("mark")?.textContent).toBe("Persimmon")
    expect(row.textContent).toContain("odh · my-branch")
  })
})

describe("HomePage mark all read", () => {
  const event: TimelineEvent = {
    id: "evt-9", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "github",
    type: "pr_comment", type_label: "", title: "Please take another look", body: "", author: "someone",
    resource_type: "pr", resource_id: "o/r#9", resource_url: "https://gh/pr/9", resource_title: "Theirs",
    worktrees: ["my-branch"], worktree_paths: ["/wt/foo"], unread: true,
  }
  beforeEach(() => {
    vi.spyOn(api, "allResources").mockResolvedValue([
      { type: "pr", id: "o/r#9", url: "https://gh/pr/9", primary: true, title: "Theirs", state: "OPEN",
        unread_count: 1, unread_through_ts: "2026-10-01T00:00:00Z",
        worktrees: [{ path: "/wt/foo", repo: "odh", branch: "my-branch" }] },
    ])
  })
  const button = () => screen.queryByRole("button", { name: "Mark all read" })

  it("offers it over the whole feed, counting every worktree's resources", async () => {
    setViewport("wide")
    wrap()
    await userEvent.click(await screen.findByRole("button", { name: "Mark all read" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("checkbox", { name: "Mark 1 GitHub event in 1 PR as read" })).toBeChecked()
  })

  it("is hidden while searching", async () => {
    setViewport("wide")
    window.history.replaceState({}, "", "/?q=kumquat")
    wrap()
    await waitFor(() => expect(api.allResources).toHaveBeenCalled())
    expect(button()).toBeNull()
  })

  it("is hidden while a source filter narrows the feed", async () => {
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    await screen.findByRole("button", { name: "Mark all read" })
    await user.click(within(document.querySelector<HTMLElement>("[data-activity-header]")!).getByRole("button", { name: /GitHub/ }))
    expect(button()).toBeNull()
  })

  it("stays with Show archived on, which only adds to the feed", async () => {
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    await screen.findByRole("button", { name: "Mark all read" })
    await user.click(screen.getByLabelText("Show archived"))
    expect(button()).not.toBeNull()
  })

  it("a previewed event opens its details over the modal, and stays on the page", async () => {
    setViewport("wide")
    mocks.events = [event]
    const user = userEvent.setup()
    wrap()
    const before = window.location.pathname
    await user.click(await screen.findByRole("button", { name: "Mark all read" }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByText("Please take another look"))
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(2))
    expect(screen.getByRole("dialog", { name: "Mark all read" })).toBeInTheDocument()
    expect(window.location.pathname).toBe(before)
  })
})

describe("HomePage tasks", () => {
  /** jsdom has no layout: make the capped list read as overflowing. */
  const mockOverflow = () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 500 })
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 240 })
  }
  afterEach(() => {
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  })

  it("wide: no Tasks tab; the panel carries the list and its toolbar", async () => {
    setViewport("wide")
    wrap()
    const bar = screen.getByRole("tablist")
    expect(within(bar).getAllByRole("tab").map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Activity", "Resources"])
    expect(within(bar).queryByLabelText("Sort tasks")).toBeNull()
    const panel = screen.getByTestId("tasks-panel")
    expect(panel).toHaveAttribute("data-level", "normal")
    expect(within(panel).getByLabelText("Sort tasks")).toBeInTheDocument()
    expect(await within(panel).findByText("Write the docs")).toBeInTheDocument()
  })

  it("wide: the panel scrolls with the column above the pinned header, on every tab, in every level", async () => {
    setViewport("wide")
    mockOverflow()
    wrap()
    const panel = () => screen.getByTestId("tasks-panel")
    const aboveThePinnedHeader = (selector: string, level: string) => {
      const header = document.querySelector(selector) as HTMLElement
      expect(panel()).toHaveAttribute("data-level", level)
      expect(header.style.position).toBe("sticky")
      expect(header).toHaveAttribute("data-tooltip-layer", "pinned")
      expect(header).not.toContainElement(panel())
      expect(panel().closest("[style*=sticky]")).toBeNull()
      expect(panel().compareDocumentPosition(within(header).getByRole("tablist")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    aboveThePinnedHeader("[data-activity-header]", "normal")
    await userEvent.click(await within(panel()).findByRole("button", { name: /^Show all \(/ }))
    aboveThePinnedHeader("[data-activity-header]", "expanded")
    // A tab change keeps it expanded; Resources' header is pinned too.
    await userEvent.click(screen.getByRole("tab", { name: "Resources" }))
    aboveThePinnedHeader("[data-testid=resources-header]", "expanded")
    await userEvent.click(within(panel()).getByRole("button", { name: /^Collapse task list/ }))
    aboveThePinnedHeader("[data-testid=resources-header]", "collapsed")
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }))
    aboveThePinnedHeader("[data-activity-header]", "collapsed")
    // The worktree column scrolls on its own; its header stays pinned.
    expect((document.querySelector("[data-worktrees-header]") as HTMLElement).style.position).toBe("sticky")
  })

  it("narrow: the panel renders above the tabs, which have no Tasks tab", async () => {
    setViewport("narrow")
    wrap()
    const panel = screen.getByTestId("tasks-panel")
    expect(await within(panel).findByText("Write the docs")).toBeInTheDocument()
    const bar = screen.getByRole("tablist")
    expect(panel.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(bar).getAllByRole("tab").map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Worktrees", "Activity", "Resources"])
  })

  it("collapsed: one line above the tab bar", async () => {
    setViewport("wide")
    window.localStorage.setItem(TASK_LIST_KEY, JSON.stringify({ collapsed: true }))
    wrap()
    const panel = screen.getByTestId("tasks-panel")
    expect(panel).toHaveAttribute("data-level", "collapsed")
    expect(within(panel).getByRole("button", { name: /^Expand task list/ })).toBeInTheDocument()
    expect(within(panel).queryByTestId("task-list-body")).toBeNull()
  })
})
