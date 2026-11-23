import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ArchivedResourceModal } from "./ArchivedResourceModal"
import type { AllResourceDTO, WorktreeSummary } from "../../api/types"

vi.mock("../../hooks/useWorktrees", () => ({
  useWorktrees: () => ({ data: [{ path: "/wt/foo", repo: "odh", branch: "my-branch" } as WorktreeSummary] }),
}))

const r: AllResourceDTO = {
  type: "pr", id: "o/r#7", url: "https://gh/pr/7", primary: false, title: "Retired work", custom_name: "Mine",
  worktrees: [], archived: true,
  last_followed_by: [{ path: "/wt/old", repo: "odh", branch: "old-branch" }],
}

const wrap = (onFollow = vi.fn(), onClose = vi.fn()) => render(
  <QueryClientProvider client={new QueryClient()}>
    <MantineProvider><ArchivedResourceModal r={r} onFollow={onFollow} onClose={onClose} /></MantineProvider>
  </QueryClientProvider>,
)
beforeEach(() => window.history.replaceState({}, "", "/"))
afterEach(cleanup)

describe("ArchivedResourceModal", () => {
  it("shows the resource, where it was last followed, and an Open link", () => {
    wrap()
    // A PR row (ResourceCardBody) names itself by its title; the custom name is not shown.
    expect(screen.getByText("Retired work")).toBeInTheDocument()
    expect(screen.queryByText("Mine")).toBeNull()
    expect(screen.getByText(/Last followed in/)).toHaveTextContent("old-branch")
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "https://gh/pr/7")
  })
  it("follows in the worktree picked from the Follow menu", async () => {
    const onFollow = vi.fn()
    wrap(onFollow)
    await userEvent.click(screen.getByRole("button", { name: /Follow/ }))
    await userEvent.click(await screen.findByRole("menuitem", { name: /foo/ }))
    expect(onFollow).toHaveBeenCalledWith("/wt/foo")
  })
  it("renders nothing without a resource", () => {
    render(<MantineProvider><ArchivedResourceModal r={null} onFollow={() => {}} onClose={() => {}} /></MantineProvider>)
    expect(screen.queryByText("Retired work")).toBeNull()
  })
})
