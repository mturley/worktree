import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AllResourceDTO } from "../api/types"
import { api } from "../api/client"
import { AllResourceRow } from "./AllResourceRow"
import { CrossHoverProvider } from "./CrossHoverContext"

const pr = (extra: Partial<AllResourceDTO> = {}): AllResourceDTO => ({
  type: "pr", id: "o/r#1", url: "https://github.com/o/r/pull/1", primary: true, title: "Shared PR",
  worktrees: [{ path: "/wt/a", repo: "r", branch: "branch-a" }], ...extra,
})

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MantineProvider><CrossHoverProvider>{ui}</CrossHoverProvider></MantineProvider>
    </QueryClientProvider>,
  )

beforeEach(() => {
  window.history.replaceState({}, "", "/")
  vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
  vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false, tabs: [] } as never)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("AllResourceRow task count", () => {
  it("shows the lime open-task count, named on hover", () => {
    wrap(<AllResourceRow r={pr({ open_task_count: 3 })} />)
    const badge = within(screen.getByTestId("all-resource-row")).getByText("3 tasks").closest(".task-count-badge")
    expect(badge).not.toBeNull()
    expect(badge).toHaveAttribute("title", "3 open tasks")
  })

  it("sits beside the unread badge", () => {
    wrap(<AllResourceRow r={pr({ open_task_count: 1, has_unread: true, unread_count: 2 })} />)
    const row = screen.getByTestId("all-resource-row")
    expect(within(row).getByText("1 task").closest(".task-count-badge")).toHaveAttribute("title", "1 open task")
    expect(within(row).getByText(/2/)).toBeInTheDocument()
  })

  it("shows none for zero or absent", () => {
    const { container } = wrap(<AllResourceRow r={pr()} />)
    expect(container.querySelector(".task-count-badge")).toBeNull()
  })
})

describe("AllResourceRow blocks badge", () => {
  it("shows a red blocks badge when the resource blocks open tasks", () => {
    wrap(<AllResourceRow r={pr({ blocks_count: 2, open_task_count: 1 })} />)
    const badge = within(screen.getByTestId("all-resource-row")).getByTestId("blocks-badge")
    expect(badge).toHaveTextContent("⛔ blocks 2")
    expect(badge).toHaveAttribute("title", "Blocks 2 open tasks")
  })

  it("shows none at zero or absent", () => {
    wrap(<AllResourceRow r={pr({ blocks_count: 0 })} />)
    expect(screen.queryByTestId("blocks-badge")).toBeNull()
  })
})

describe("AllResourceRow worktrees line", () => {
  it("names a worktree by its cmux workspace, and previews it on hover", async () => {
    vi.mocked(api.cmux).mockResolvedValue({
      available: true,
      matches: { "/wt/a": [{ ref: "workspace:1", title: "Feature work", color: "#00ff00", selected: false }] },
    } as never)
    wrap(<AllResourceRow r={pr({ worktrees: [{ path: "/wt/a", repo: "r", branch: "a" }, { path: "/wt/b", repo: "r", branch: "b" }] })} />)
    const ws = await screen.findByText("Feature work")
    // A worktree with no workspace keeps its ⎇ name.
    expect(screen.getByText("b")).toBeInTheDocument()

    await userEvent.hover(ws)
    expect(await screen.findByText("⎇ a")).toBeInTheDocument()
  })
})
