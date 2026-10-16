import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, act, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ResourceDTO, TimelineEvent } from "../api/types"
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
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
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
          <ResourceDetailPane path="/wt/foo" resource={r} />
        </QueryClientProvider>
      </MantineProvider>
    )
    const { rerender } = render(mk({ ...jira, id: "J-1", unread_count: 2 }))
    expect(await screen.findByRole("tab", { name: "Linked Resources (3)" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("button", { name: "Mark 2 events as read" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: "Linked Resources (3)" }))
    expect(screen.queryByRole("button", { name: /Mark .* as read/ })).not.toBeInTheDocument()
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
          <ResourceDetailPane path="/wt/foo" resource={jira} />
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

  it("draws the button in unread blue, not the theme's purple accent", () => {
    // primaryColor is "accent" (purple). This button clears the very blue the
    // event boxes beside it are drawn in, so it wears the same colour — and
    // hovers LIGHTER, since Mantine's darker default reads as dimming on a
    // dark background.
    withEvents()
    wrap(<ResourceDetailPane path="/wt/foo" resource={{ ...jira, unread_count: 2 } as ResourceDTO} />)
    const btn = screen.getByRole("button", { name: "Mark 2 events as read" })
    expect(btn).toHaveAttribute("data-variant", "filled")
    expect(btn.style.getPropertyValue("--button-hover")).toBe("var(--mantine-color-blue-4)")
  })

  it("offers to mark the resource's unread events read", () => {
    withEvents()
    wrap(<ResourceDetailPane path="/wt/foo" resource={{ ...jira, unread_count: 3 } as ResourceDTO} />)
    expect(screen.getByRole("button", { name: "Mark 3 events as read" })).toBeInTheDocument()
  })

  it("sends the newest RENDERED event as through_ts, so later arrivals survive", async () => {
    withEvents()
    wrap(<ResourceDetailPane path="/wt/foo" resource={{ ...jira, unread_count: 1 } as ResourceDTO} />)
    await userEvent.click(screen.getByRole("button", { name: "Mark 1 event as read" }))
    expect(markResourceRead).toHaveBeenCalledWith({
      type: "jira", id: "J-1", through_ts: "2099-01-02T00:00:00Z",
    })
  })

  it("hides the mark-read button when nothing is unread", () => {
    withEvents()
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(screen.queryByRole("button", { name: /Mark .* as read/ })).not.toBeInTheDocument()
  })

  it("never calls markResourceRead on a plain render with no interaction", () => {
    // The worst outcome for this feature is an implicit mark-read (e.g. a
    // future useEffect creeping back in). Rendering alone must never call it.
    withEvents()
    wrap(<ResourceDetailPane path="/wt/foo" resource={{ ...jira, unread_count: 3 } as ResourceDTO} />)
    expect(markResourceRead).not.toHaveBeenCalled()
  })

  it("disables the mark-read button when the timeline has no events to source through_ts from", () => {
    useWorktreeTimeline.mockReturnValue({
      events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false,
    })
    wrap(<ResourceDetailPane path="/wt/foo" resource={{ ...jira, unread_count: 3 } as ResourceDTO} />)
    expect(screen.getByRole("button", { name: "Mark 3 events as read" })).toBeDisabled()
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
