import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { ResourceDTO } from "../api/types"

const resources: ResourceDTO[] = [
  { type: "pr", id: "o/r#1", url: "https://gh/pr/1", primary: true, title: "Fix the widget", state: "OPEN" } as ResourceDTO,
  { type: "jira", id: "J-1", url: "https://jira/J-1", primary: true, title: "Investigate flux", status: "In Progress" } as ResourceDTO,
]

vi.mock("../hooks/useWorktreeDetail", () => ({
  useWorktreeDetail: () => ({
    resources: { data: resources, refetch: vi.fn() },
    timeline: { events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false },
  }),
}))
// Return a summary whose path matches the route, so the page can render its
// WorktreeCard header (spec item 3).
vi.mock("../hooks/useWorktrees", () => ({
  useWorktrees: () => ({
    data: [{
      path: "/wt/foo", repo: "odh", branch: "foo",
      on_disk: true, resource_count: 2, primary_count: 2, latest_event_ts: "",
      primary_by_type: { pr: 1, jira: 1 }, related_count: 0,
      focus_resources: [
        { type: "pr", id: "o/r#1", url: "https://gh/pr/1", primary: true, title: "Card header PR", state: "OPEN" },
      ],
    }],
  }),
}))
vi.mock("../hooks/useTimeline", () => ({
  useWorktreeTimeline: () => ({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false }),
}))

import { setViewport } from "../testing/viewport"
import { WorktreeDetailPage } from "./WorktreeDetailPage"

const wrap = () => render(<MantineProvider><WorktreeDetailPage /></MantineProvider>)

beforeEach(() => window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}`))
afterEach(cleanup)

describe("WorktreeDetailPage header", () => {
  it("renders the worktree card above the tabs, without card navigation", async () => {
    setViewport("wide")
    wrap()
    // The card's focus-resource line is present. Its title is distinct from
    // anything in the resource list, so this can only be satisfied by the
    // WorktreeCard header actually rendering.
    expect(await screen.findByRole("link", { name: /Card header PR/ })).toBeInTheDocument()
    // ...but the card is not a navigation target here (clickable={false}).
    expect(screen.queryByRole("link", { name: /open worktree foo/i })).not.toBeInTheDocument()
  })
})

describe("WorktreeDetailPage selection", () => {
  it("selects a resource on click and records it in the URL", async () => {
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getByRole("button", { name: /select resource o\/r#1/i }))
    await waitFor(() => expect(window.location.search).toContain("resource=pr%3A"))
  })

  it("shows the drilldown with a back control when narrow and selected", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("narrow")
    wrap()
    expect(await screen.findByRole("button", { name: /all resources for worktree/i })).toBeInTheDocument()
  })

  it("returns to the list when the back control is used", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("narrow")
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("button", { name: /all resources for worktree/i }))
    await waitFor(() => expect(window.location.search).not.toContain("resource="))
  })

  it("keeps the resource list visible beside the pane when wide", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("wide")
    wrap()
    // The list is still there (the other resource is selectable) and there is
    // no back control in the wide layout.
    expect(await screen.findByRole("button", { name: /select resource J-1/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /all resources for worktree/i })).not.toBeInTheDocument()
  })

  it("clears a ?resource= that matches no loaded resource, without growing history (replace, not push)", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:gone%23999`)
    setViewport("wide")
    const before = window.history.length
    wrap()
    await waitFor(() => expect(window.location.search).not.toContain("resource="))
    // The correction must REPLACE the history entry, not push a new one, or
    // the back button can never escape the stale-selection <-> clean loop.
    expect(window.history.length).toBe(before)
  })

  it("deselects and clears ?resource= when the selected resource is clicked again", async () => {
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    const card = screen.getByRole("button", { name: /select resource o\/r#1/i })
    await user.click(card)
    await waitFor(() => expect(window.location.search).toContain("resource=pr%3A"))
    await user.click(card)
    await waitFor(() => expect(window.location.search).not.toContain("resource="))
  })
})

describe("WorktreeDetailPage has no Overview/Slack tabs", () => {
  it("renders the resource list as the page body, with no tab bar", async () => {
    setViewport("wide")
    wrap()
    // Slack threads are now selected like any other resource, so the
    // Overview/Slack tab split is gone entirely.
    expect(await screen.findByRole("button", { name: /select resource o\/r#1/i })).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Overview" })).not.toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Slack" })).not.toBeInTheDocument()
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
  })
})
