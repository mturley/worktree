import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ResourceDTO, TimelineEvent } from "../api/types"

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
  it("requests the timeline filtered to the selected resource", () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(useWorktreeTimeline).toHaveBeenCalledWith("/wt/foo", { type: "jira", id: "J-1" })
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
