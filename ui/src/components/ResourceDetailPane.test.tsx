import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, act, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { TaskModalProvider } from "./tasks/modal/TaskModalProvider"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ResourceDTO, Task, TimelineEvent } from "../api/types"
import { TASK_LIST_KEY } from "../lib/taskListPrefs"
import { api as realApi } from "../api/client"

const useWorktreeTimeline = vi.fn()
vi.mock("../hooks/useTimeline", () => ({
  useWorktreeTimeline: (...args: unknown[]) => useWorktreeTimeline(...args),
}))

const removeResource = vi.fn()
const markResourceRead = vi.fn()
const watchers = vi.fn()
const pollWatchers = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { api: {
    ...actual.api,
    removeResource: (...args: unknown[]) => removeResource(...args),
    markResourceRead: (...args: unknown[]) => markResourceRead(...args),
    watchers: () => watchers(),
    pollWatchers: () => pollWatchers(),
  } }
})

import { ResourceDetailPane } from "./ResourceDetailPane"

const jira: ResourceDTO = {
  type: "jira", id: "J-1", url: "https://jira/browse/J-1", primary: true,
  title: "Investigate flux", status: "In Progress", labels: ["backend"],
} as ResourceDTO

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}><TaskModalProvider>{ui}</TaskModalProvider></QueryClientProvider>
    </MantineProvider>,
  )
}

beforeEach(() => {
  // The active tab lives in the URL (?tab=), so a test that switches tabs
  // would otherwise start the next one on that tab.
  window.history.replaceState({}, "", "/worktree/wt")
  watchers.mockResolvedValue({ watchers: [], polling: false })
  pollWatchers.mockResolvedValue(null)
  // A default so tests that care only about the header do not each have to
  // stand up a timeline; tests about the feed override it.
  useWorktreeTimeline.mockReturnValue({
    events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false,
  })
})

afterEach(() => {
  cleanup()
  useWorktreeTimeline.mockReset()
  removeResource.mockReset()
  markResourceRead.mockReset()
  watchers.mockReset()
  pollWatchers.mockReset()
})

describe("ResourceDetailPane", () => {
  it("shows Activity by default, and keeps the chosen tab in the URL", async () => {
    vi.spyOn(realApi, "linkedResources").mockResolvedValue({ fetched_at: "2026-10-09T12:00:00Z", count: 3, sections: [] })
    const mk = (r: ResourceDTO) => (
      <MantineProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <TaskModalProvider><ResourceDetailPane path="/wt/foo" resource={r} /></TaskModalProvider>
        </QueryClientProvider>
      </MantineProvider>
    )
    const { rerender } = render(mk({ ...jira, id: "J-1", unread_count: 2 }))
    expect(await screen.findByRole("tab", { name: "Linked Resources (3)" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true")
    await userEvent.click(screen.getByRole("tab", { name: "Linked Resources (3)" }))
    expect(window.location.search).toContain("tab=linked")
    // Back (or anything else that drops ?tab=) returns to Activity; selecting
    // another resource drops it too — see useSelectedResource's tests.
    await act(async () => {
      window.history.back()
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(window.location.search).not.toContain("tab="))
    rerender(mk({ ...jira, id: "J-1", unread_count: 2 }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true"))
  })

  it("dots the Activity tab while it has unreads you can't see", async () => {
    vi.spyOn(realApi, "linkedResources").mockResolvedValue({ fetched_at: "2026-10-09T12:00:00Z", count: 0, sections: [] })
    wrap(<ResourceDetailPane path="/wt/foo" resource={{ ...jira, unread_count: 2 }} />)
    expect(screen.queryByLabelText("unread activity")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: /Linked Resources/ }))
    expect(screen.getByLabelText("unread activity")).toBeInTheDocument()
  })

  it("does not dot the Activity tab when nothing is unread", async () => {
    vi.spyOn(realApi, "linkedResources").mockResolvedValue({ fetched_at: "2026-10-09T12:00:00Z", count: 0, sections: [] })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    await userEvent.click(screen.getByRole("tab", { name: /Linked Resources/ }))
    expect(screen.queryByLabelText("unread activity")).not.toBeInTheDocument()
  })

  it("resets the hierarchy's expand/collapse state on returning to the Linked tab", async () => {
    vi.spyOn(realApi, "linkedResources").mockResolvedValue({
      fetched_at: "2026-10-09T12:00:00Z",
      count: 2,
      sections: [{ kind: "hierarchy", title: "Hierarchy", tree: [
        { type: "jira", id: "J-1", url: "u1", resolved: true, title: "Me", current: true, expanded: false, has_children: true, children: [
          { type: "jira", id: "J-2", url: "u2", resolved: true, title: "Child story", expanded: false, has_children: false },
        ] },
      ] }],
    })
    vi.spyOn(realApi, "cmuxBrowserTabs").mockResolvedValue({ available: false, tabs: [] })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    await userEvent.click(screen.getByRole("tab", { name: /Linked Resources/ }))
    await userEvent.click(await screen.findByRole("button", { name: "Expand J-1" }))
    expect(screen.getByText("Child story")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }))
    await userEvent.click(screen.getByRole("tab", { name: /Linked Resources/ }))
    expect(await screen.findByRole("button", { name: "Expand J-1" })).toBeInTheDocument()
    expect(screen.queryByText("Child story")).not.toBeInTheDocument()
  })

  it("opens on the Linked tab when the URL says so", async () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=jira:J-1&tab=linked")
    const spy = vi.spyOn(realApi, "linkedResources").mockResolvedValue({ fetched_at: "2026-10-09T12:00:00Z", count: 0, sections: [] })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(await screen.findByRole("tab", { name: /Linked Resources/ })).toHaveAttribute("aria-selected", "true")
    // Arriving on the tab counts as opening it: link titles are fetched.
    await waitFor(() => expect(spy).toHaveBeenCalledWith("jira", "J-1", { resolveLinks: true }))
  })

  it("requests the timeline filtered to the selected resource", () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(useWorktreeTimeline).toHaveBeenCalledWith("/wt/foo", { type: "jira", id: "J-1" }, [], false, [], "")
  })

  it("counts matching events directly above the feed while searching", async () => {
    window.history.replaceState({}, "", "/worktree/wt?q=kumquat")
    useWorktreeTimeline.mockReturnValue({
      events: [{
        id: "e1", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "jira", type: "jira_comment", type_label: "",
        title: "Kumquat note", body: "", author: "a", resource_type: "jira", resource_id: "J-1", resource_url: "",
        resource_title: "", worktrees: [],
      }],
      isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false,
    })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(await screen.findByText("1 event")).toBeInTheDocument()
    expect(screen.getByTestId("search-summary").textContent).toBe("1 event matches your search. Clear search Esc")
  })

  it("counts linked matches in the tab label while searching", async () => {
    window.history.replaceState({}, "", "/worktree/wt?q=blocker")
    vi.spyOn(realApi, "linkedResources").mockResolvedValue({
      fetched_at: "2026-10-09T12:00:00Z", count: 2, sections: [{ kind: "description", title: "D", items: [
        { type: "jira", id: "P-1", url: "u", resolved: true, title: "Blocker" },
        { type: "jira", id: "P-2", url: "u", resolved: true, title: "Other" },
      ] }],
    })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(await screen.findByRole("tab", { name: "Linked Resources (1)" })).toBeInTheDocument()
  })

  it("shows no match line without a search", () => {
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(screen.queryByTestId("search-summary")).toBeNull()
  })

  it("shows the detailed resource summary, including Jira labels", () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(screen.getByText("backend")).toBeInTheDocument()
  })

  it("renders a back control only when onBack is supplied", async () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    const onBack = vi.fn()
    const user = userEvent.setup()
    const { rerender } = wrap(<ResourceDetailPane path="/wt/foo" resource={jira} onBack={onBack} />)
    await user.click(screen.getByRole("button", { name: /all resources/i }))
    expect(onBack).toHaveBeenCalled()

    rerender(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <TaskModalProvider><ResourceDetailPane path="/wt/foo" resource={jira} /></TaskModalProvider>
        </QueryClientProvider>
      </MantineProvider>,
    )
    expect(screen.queryByRole("button", { name: /all resources/i })).not.toBeInTheDocument()
  })

  it("wires the remove control to the real worktree path, not an empty one", async () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    removeResource.mockResolvedValue(undefined)
    const onRemoved = vi.fn()
    const user = userEvent.setup()
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} onRemoved={onRemoved} />)

    await user.click(screen.getByRole("button", { name: "Unfollow resource" }))
    await screen.findByText("Unfollow this resource?")
    await user.click(screen.getByRole("button", { name: "Unfollow" }))

    expect(removeResource).toHaveBeenCalledWith({ path: "/wt/foo", type: "jira", id: "J-1" })
    await vi.waitFor(() => expect(onRemoved).toHaveBeenCalled())
  })
})

describe("more activity link", () => {
  it("offers a way out to the full history on the source service", async () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={{ ...jira, type: "pr", id: "o/r#1", url: "https://gh/pr/1" } as ResourceDTO} />)
    // The feed only holds what the poller captured for this worktree, so the
    // reader needs a way to the rest.
    const link = await screen.findByRole("link", { name: /more activity on github/i })
    expect(link.getAttribute("href")).toBe("https://gh/pr/1")
    expect(link.getAttribute("target")).toBe("_blank")
  })

  it("names Jira for a Jira issue", async () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(await screen.findByRole("link", { name: /more activity on jira/i })).toBeInTheDocument()
  })

  it("omits it when the resource has no url", async () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={{ ...jira, type: "pr", id: "o/r#1", url: "" } as ResourceDTO} />)
    await screen.findByText("Activity")
    expect(screen.queryByRole("link", { name: /more activity/i })).not.toBeInTheDocument()
  })
})

describe("mark-read button", () => {
  const withEvents = () =>
    useWorktreeTimeline.mockReturnValue({
      events: [{
        id: "e1", ts: "2099-01-02T00:00:00Z", unread: true, type: "pr_comment",
        type_label: "PR comments", title: "event e1", body: "", author: "", source: "github",
        external_ts: "", resource_type: "jira", resource_id: "J-1", resource_url: "u",
        resource_title: "", worktrees: [],
      } as TimelineEvent],
      isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false,
    })
  const unread = (n: number) =>
    ({ ...jira, unread_count: n, unread_through_ts: "2099-01-02T00:00:00Z" }) as ResourceDTO

  it("sits in the tab bar as Mark all read, like the other feeds'", () => {
    withEvents()
    wrap(<ResourceDetailPane path="/wt/foo" resource={unread(2)} />)
    const btn = screen.getByRole("button", { name: "Mark all read" })
    expect(btn.closest('[role="tablist"]')).not.toBeNull()
  })

  it("confirms in a modal that previews the unread events, with no checkboxes", async () => {
    withEvents()
    wrap(<ResourceDetailPane path="/wt/foo" resource={unread(2)} />)
    await userEvent.click(screen.getByRole("button", { name: "Mark all read" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument()
    expect(within(dialog).getByText("The following 2 events will be marked as read")).toBeInTheDocument()
    expect(within(dialog).getByText("event e1")).toBeInTheDocument()
    // The preview is this resource's unread events alone.
    expect(useWorktreeTimeline).toHaveBeenCalledWith("/wt/foo", { type: "jira", id: "J-1" }, [], true)
    expect(markResourceRead).not.toHaveBeenCalled()
  })

  it("marks the resource read through what the server counted, on confirm", async () => {
    withEvents()
    markResourceRead.mockResolvedValue(null)
    wrap(<ResourceDetailPane path="/wt/foo" resource={unread(1)} />)
    await userEvent.click(screen.getByRole("button", { name: "Mark all read" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark read" }))
    expect(markResourceRead).toHaveBeenCalledWith({
      type: "jira", id: "J-1", through_ts: "2099-01-02T00:00:00Z",
    })
  })

  it("hides the mark-read button when nothing is unread", () => {
    withEvents()
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(screen.queryByRole("button", { name: "Mark all read" })).not.toBeInTheDocument()
  })

  it("hides the mark-read button on the Linked tab", async () => {
    vi.spyOn(realApi, "linkedResources").mockResolvedValue({ fetched_at: "2026-10-09T12:00:00Z", count: 0, sections: [] })
    withEvents()
    wrap(<ResourceDetailPane path="/wt/foo" resource={unread(2)} />)
    await userEvent.click(screen.getByRole("tab", { name: /Linked Resources/ }))
    expect(screen.queryByRole("button", { name: "Mark all read" })).not.toBeInTheDocument()
  })

  it("never calls markResourceRead on a plain render with no interaction", () => {
    // The worst outcome for this feature is an implicit mark-read (e.g. a
    // future useEffect creeping back in). Rendering alone must never call it.
    withEvents()
    wrap(<ResourceDetailPane path="/wt/foo" resource={unread(3)} />)
    expect(markResourceRead).not.toHaveBeenCalled()
  })
})

describe("the Activity header's watcher freshness", () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()

  it("shows when THIS resource's watcher last succeeded", async () => {
    // The feed is one resource, so "updated" means the watcher for its type —
    // jira here, not whichever watcher ran most recently.
    watchers.mockResolvedValue({
      polling: false,
      watchers: [
        { name: "github", type: "pr", last_success: minutesAgo(1) },
        { name: "jira", type: "jira", last_success: minutesAgo(7) },
      ],
    })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(await screen.findByText("Updated 7m ago")).toBeInTheDocument()
  })

  it("offers a refresh button beside the heading", async () => {
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(await screen.findByRole("button", { name: "Refresh watchers" })).toBeInTheDocument()
  })

  it("says nothing when the watcher has never succeeded", async () => {
    watchers.mockResolvedValue({ polling: false, watchers: [{ name: "jira", type: "jira" }] })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    await screen.findByRole("button", { name: "Refresh watchers" })
    expect(screen.queryByText(/^Updated /)).toBeNull()
  })

  it("marks a failing watcher", async () => {
    watchers.mockResolvedValue({
      polling: false,
      watchers: [{ name: "jira", type: "jira", last_success: minutesAgo(9), has_error: true, error_message: "401" }],
    })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(await screen.findByLabelText("jira watcher failing")).toBeInTheDocument()
  })
})

describe("the selected resource's feed", () => {
  it("does not repeat the resource on every event", async () => {
    // The card above the feed already names it; every row here belongs to it.
    useWorktreeTimeline.mockReturnValue({
      events: [{
        id: "e1", ts: "2099-01-02T00:00:00Z", unread: false, type: "jira_comment",
        type_label: "Comments", title: "a comment", body: "", author: "", source: "jira",
        external_ts: "", resource_type: "jira", resource_id: "J-1", resource_url: "u",
        resource_title: "Investigate flux", worktrees: [],
      } as TimelineEvent],
      isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false,
    })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    await screen.findByText("a comment")
    // The title appears once — on the resource card, not again on the row.
    expect(screen.getAllByText("Investigate flux")).toHaveLength(1)
  })
})

describe("ResourceDetailPane tasks", () => {
  const task: Task = {
    id: 3, ref: "T3", title: "Chase the reviewer", description: "", state: "not_started", priority: "none", starred: false,
    rank: "r1", created_at: "", updated_at: "", archived: false, links: [], implicit_worktrees: [],
    subtasks_total: 0, subtasks_done: 0,
  }
  beforeEach(() => {
    window.localStorage.clear()
    vi.spyOn(realApi, "tasks").mockResolvedValue([task])
    vi.spyOn(realApi, "linkedResources").mockResolvedValue({ fetched_at: "", count: 0, sections: [] })
  })
  afterEach(() => vi.restoreAllMocks())

  it("Activity · Linked Resources · Tasks, Tasks last with a count, scoped to the resource", async () => {
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab")
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, "").replace(/ \(\d+\)$/, ""))).toEqual(["Activity", "Linked Resources", "Tasks"])
    expect((await within(tabs[2]!).findByText("1")).closest(".task-count-badge")).not.toBeNull()
    expect(realApi.tasks).toHaveBeenCalledWith({ kind: "resource", type: "jira", id: "J-1" }, expect.anything())

    await userEvent.click(tabs[2]!)
    expect(window.location.search).toContain("tab=tasks")
    expect(await screen.findByText("Chase the reviewer")).toBeInTheDocument()
    expect(within(screen.getByRole("tablist")).getByRole("button", { name: "Pin task list" })).toBeInTheDocument()
  })

  it("pinned: the list sits in the sticky block between the card and the tab bar", async () => {
    window.localStorage.setItem(TASK_LIST_KEY, JSON.stringify({ pinned: true }))
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} stickyTop={60} />)
    const panel = document.querySelector(".task-panel") as HTMLElement
    expect(await within(panel).findByText("Chase the reviewer")).toBeInTheDocument()
    const bar = screen.getByRole("tablist")
    expect(within(bar).queryByRole("tab", { name: /Tasks/ })).toBeNull()
    expect(panel.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const title = screen.getByText("Investigate flux")
    expect(title.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const sticky = bar.parentElement!.closest<HTMLElement>("[data-tooltip-layer=pinned]")!
    expect(sticky.style.position).toBe("sticky")
    expect(sticky).toContainElement(panel)
  })

  it("pinning while on Tasks falls back to Activity", async () => {
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    await userEvent.click(screen.getByRole("tab", { name: /Tasks/ }))
    await userEvent.click(screen.getByRole("button", { name: "Pin task list" }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true"))
  })
})
