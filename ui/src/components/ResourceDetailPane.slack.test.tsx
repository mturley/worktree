import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
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

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

afterEach(() => {
  cleanup()
  useWorktreeTimeline.mockReset()
})

describe("ResourceDetailPane slack branch", () => {
  it("renders the Slack thread instead of the activity feed for a slack resource", () => {
    useWorktreeTimeline.mockReturnValue({ data: { events: [], next_cursor: "" }, isLoading: false, error: null })
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} />)

    expect(screen.getByTestId("thread-view")).toHaveTextContent("thread C123/1700000000.000100")
    expect(screen.queryByText("Activity")).not.toBeInTheDocument()
  })

  it("does not render a resource summary card above a slack thread", () => {
    // ThreadView carries its own title/description header, so a second
    // summary card above it would be duplicated chrome.
    useWorktreeTimeline.mockReturnValue({ data: { events: [], next_cursor: "" }, isLoading: false, error: null })
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} />)
    expect(screen.queryByText("Deploy thread")).not.toBeInTheDocument()
  })

  it("does not request a filtered timeline for a slack resource", () => {
    useWorktreeTimeline.mockReturnValue({ data: { events: [], next_cursor: "" }, isLoading: false, error: null })
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} />)
    expect(useWorktreeTimeline).not.toHaveBeenCalled()
  })

  it("still renders the activity feed for a non-slack resource", () => {
    useWorktreeTimeline.mockReturnValue({ data: { events: [], next_cursor: "" }, isLoading: false, error: null })
    wrap(<ResourceDetailPane path="/wt/foo" resource={pr} />)
    expect(screen.getByText("Activity")).toBeInTheDocument()
    expect(screen.queryByTestId("thread-view")).not.toBeInTheDocument()
  })

  it("keeps the narrow-viewport back control for a slack thread", () => {
    useWorktreeTimeline.mockReturnValue({ data: { events: [], next_cursor: "" }, isLoading: false, error: null })
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} onBack={vi.fn()} />)
    expect(screen.getByRole("button", { name: /all resources for worktree/i })).toBeInTheDocument()
  })
})
