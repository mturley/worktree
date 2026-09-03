import { afterEach, describe, it, expect, vi } from "vitest"
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
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { api: {
    ...actual.api,
    removeResource: (...args: unknown[]) => removeResource(...args),
    markResourceRead: (...args: unknown[]) => markResourceRead(...args),
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

afterEach(() => {
  cleanup()
  useWorktreeTimeline.mockReset()
  removeResource.mockReset()
  markResourceRead.mockReset()
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
})

