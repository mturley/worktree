import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
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

vi.mock("../hooks/useWorktrees", () => ({ useWorktrees: () => ({ data: [summary] }) }))
vi.mock("../hooks/useTimeline", () => ({
  useGlobalTimeline: () => ({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false }),
}))

import { HomePage } from "./HomePage"

const wrap = () => {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <MantineProvider><HomePage /></MantineProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => window.history.replaceState({}, "", "/"))
afterEach(cleanup)

describe("HomePage responsive layout", () => {
  it("shows a Worktrees/Timeline tab bar when narrow", () => {
    setViewport("narrow")
    wrap()
    expect(screen.getByRole("tab", { name: "Worktrees" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Timeline" })).toBeInTheDocument()
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
    expect(screen.getByRole("link", { name: /Fix the widget/ })).toBeInTheDocument()
  })
})
