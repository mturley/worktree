import { afterEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { WorktreeSummary } from "../api/types"
import { WorktreeList } from "./WorktreeList"

const summary: WorktreeSummary = {
  path: "/wt/foo", repo: "odh", branch: "my-branch",
  on_disk: true, resource_count: 1, primary_count: 1, latest_event_ts: "",
  primary_by_type: { pr: 1 }, related_count: 0,
  focus_resources: [{ type: "pr", id: "o/r#1", url: "https://gh/pr/1", primary: true, title: "Fix the widget", state: "OPEN" }],
}

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MantineProvider>,
  )
}

afterEach(cleanup)

describe("WorktreeList", () => {
  it("renders a card per worktree", () => {
    wrap(<WorktreeList items={[summary]} />)
    expect(screen.getByText(/my-branch/)).toBeInTheDocument()
    expect(screen.getByText(/Fix the widget/)).toBeInTheDocument()
  })

  it("shows an empty state with no worktrees", () => {
    wrap(<WorktreeList items={[]} />)
    expect(screen.getByText(/No worktrees/)).toBeInTheDocument()
  })
})
