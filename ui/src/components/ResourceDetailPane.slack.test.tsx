import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ResourceDTO } from "../api/types"

if (typeof (globalThis as { EventSource?: unknown }).EventSource !== "function") {
  ;(globalThis as { EventSource: unknown }).EventSource = class {
    close() {}
    set onmessage(_: unknown) {}
    set onerror(_: unknown) {}
  }
}

const useWorktreeTimeline = vi.fn()
vi.mock("../hooks/useTimeline", () => ({
  useWorktreeTimeline: (...a: unknown[]) => useWorktreeTimeline(...a),
}))

// ThreadView is heavy (mrkdwn, emoji, blocks); stand it in so this test is
// about the PANE's routing decision, not the thread renderer's internals.
vi.mock("./slack/ThreadView", () => ({
  ThreadView: ({ tab }: { tab: { channel: string; threadTs: string } }) => (
    <div data-testid="thread-view">{`thread ${tab.channel}/${tab.threadTs}`}</div>
  ),
}))

vi.mock("../hooks/useThread", () => ({
  useThread: () => ({ data: undefined, status: "ready", error: undefined, refresh: vi.fn(), applyLocal: vi.fn() }),
}))

import { ResourceDetailPane } from "./ResourceDetailPane"

const slack: ResourceDTO = {
  type: "slack", id: "C123:1700000000.000100",
  url: "https://acme.slack.com/archives/C123/p1700000000000100",
  primary: true, custom_name: "Deploy thread",
} as ResourceDTO

const pr: ResourceDTO = {
  type: "pr", id: "o/r#1", url: "https://gh/pr/1", primary: true, title: "Fix the widget", state: "OPEN",
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
})

describe("ResourceDetailPane slack branch", () => {
  it("renders the Slack thread instead of the activity feed for a slack resource", () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} />)

    expect(screen.getByTestId("thread-view")).toHaveTextContent("thread C123/1700000000.000100")
    expect(screen.queryByText("Activity")).not.toBeInTheDocument()
  })

  it("renders the shared detail card above the slack thread", () => {
    // Card unification: ThreadView no longer carries its own header block, so
    // the same ResourceCard heads every resource type. Needing ThreadView's
    // header slot twice (remove in phase C, focus/related next) was the
    // signal the seam was in the wrong place.
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} onRemoved={vi.fn()} />)
    expect(screen.getByText("Deploy thread")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open in Slack" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Unfollow resource" })).toBeInTheDocument()
  })

  it("does not request a filtered timeline for a slack resource", () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} />)
    expect(useWorktreeTimeline).not.toHaveBeenCalled()
  })

  it("still renders the activity feed for a non-slack resource", () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={pr} />)
    expect(screen.getByText("Activity")).toBeInTheDocument()
    expect(screen.queryByTestId("thread-view")).not.toBeInTheDocument()
  })

  it("keeps the narrow-viewport back control for a slack thread", () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} onBack={vi.fn()} />)
    expect(screen.getByRole("button", { name: /all resources/i })).toBeInTheDocument()
  })
})

describe("ResourceDetailPane slack remove control", () => {
  it("puts the remove control on the shared card, not in a ThreadView slot", () => {
    // Phase B gives a slack thread no detail ResourceCard, so without this the
    // thread would be the one resource type you cannot remove from the UI.
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} onRemoved={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Unfollow resource" })).toBeInTheDocument()
  })
})
