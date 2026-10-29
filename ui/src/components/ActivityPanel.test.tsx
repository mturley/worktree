import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskModalProvider } from "./tasks/modal/TaskModalProvider"
import type { TimelineEvent } from "../api/types"

const mocks = vi.hoisted(() => ({ events: [] as TimelineEvent[] }))
vi.mock("../hooks/useTimeline", () => ({
  useGlobalTimeline: () => ({
    events: mocks.events, isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false,
  }),
}))

import { useActivityPanel, type EventSelectMode } from "./ActivityPanel"
import { api } from "../api/client"

function Host({ select }: { select: EventSelectMode }) {
  const activity = useActivityPanel({ unreadOnly: false, select })
  return <>{activity.render()}{activity.modals}</>
}

const wrap = (select: EventSelectMode) => render(
  <QueryClientProvider client={new QueryClient()}>
    <MantineProvider><TaskModalProvider><Host select={select} /></TaskModalProvider></MantineProvider>
  </QueryClientProvider>,
)

const event: TimelineEvent = {
  id: "evt-1", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "github",
  type: "pr_comment", type_label: "", title: "Looks good to me", body: "Ship the gizmo", author: "someone",
  resource_type: "pr", resource_id: "o/r#1", resource_url: "https://gh/pr/1", resource_title: "Fix the widget",
  worktrees: ["my-branch"], worktree_paths: ["/wt/foo"],
}

beforeEach(() => {
  window.history.replaceState({}, "", "/mini")
  window.localStorage.clear()
  window.sessionStorage.clear()
  mocks.events = []
  vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
  vi.spyOn(api, "tasks").mockResolvedValue([])
  vi.spyOn(api, "allResources").mockResolvedValue([])
})
afterEach(() => vi.restoreAllMocks())
afterEach(cleanup)

describe("useActivityPanel select: details", () => {
  it("opens the event's details instead of routing to its worktree", async () => {
    mocks.events = [event]
    wrap("details")
    await userEvent.click(screen.getByText("Looks good to me"))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Ship the gizmo")).toBeInTheDocument()
    expect(window.location.pathname).toBe("/mini")
  })
})
