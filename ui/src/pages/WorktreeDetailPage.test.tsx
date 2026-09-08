import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
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

// The header card (WorktreeDetailCard) fetches /api/worktree-info, so the
// page now needs a QueryClient. A fresh one per render keeps tests isolated.
const wrap = () =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <WorktreeDetailPage />
      </QueryClientProvider>
    </MantineProvider>,
  )

beforeEach(() => window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}`))
afterEach(cleanup)

describe("WorktreeDetailPage header", () => {
  it("renders a header card that is not a navigation target", async () => {
    setViewport("wide")
    wrap()
    // The worktree's name heads the card. ("foo" also appears in the page
    // title, so assert presence rather than uniqueness.)
    await waitFor(() => expect(screen.getAllByText("foo").length).toBeGreaterThan(0))
    // ...but it is not a link: you are already on this worktree's page.
    expect(screen.queryByRole("link", { name: /open worktree foo/i })).not.toBeInTheDocument()
  })

  it("omits focus-resource lines, which would duplicate the resource cards", async () => {
    setViewport("wide")
    wrap()
    await waitFor(() => expect(screen.getAllByText("foo").length).toBeGreaterThan(0))
    // "Card header PR" exists ONLY in the summary's focus_resources fixture,
    // never in the resource list — so its absence proves the header card no
    // longer repeats what the cards below already show.
    expect(screen.queryByRole("link", { name: /Card header PR/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Card header PR/)).not.toBeInTheDocument()
  })

  it("shows the summary card by default", async () => {
    // A first visit that hid it would look broken — the card IS the page's
    // identity. Note toBeVisible, not toBeInTheDocument: Mantine's Collapse
    // keeps its children mounted, so presence proves nothing about state.
    setViewport("wide")
    wrap()
    await waitFor(() => expect(screen.getByRole("button", { name: "Hide details" })).toBeInTheDocument())
    expect(screen.getByText("WORKTREE")).toBeVisible()
  })

  it("hides the summary card on demand, freeing the space for the resources", async () => {
    setViewport("wide")
    wrap()
    await userEvent.click(await screen.findByRole("button", { name: "Hide details" }))
    expect(screen.getByText("WORKTREE")).not.toBeVisible()
    // The toggle names the state it will move to, so it reads as an action.
    expect(screen.getByRole("button", { name: "Show details" })).toBeInTheDocument()
  })

  it("brings it back on a second click", async () => {
    setViewport("wide")
    wrap()
    await userEvent.click(await screen.findByRole("button", { name: "Hide details" }))
    await userEvent.click(screen.getByRole("button", { name: "Show details" }))
    expect(screen.getByText("WORKTREE")).toBeVisible()
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
    expect(await screen.findByRole("button", { name: /all resources/i })).toBeInTheDocument()
  })

  it("returns to the list when the back control is used", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("narrow")
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("button", { name: /all resources/i }))
    await waitFor(() => expect(window.location.search).not.toContain("resource="))
  })

  it("keeps the resource list visible beside the pane when wide", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("wide")
    wrap()
    // The list is still there (the other resource is selectable), AND the
    // back control is offered even when both panes are visible: deselecting
    // is how the worktree's cross-resource timeline comes back, and clicking
    // the selected card again was previously the only way to do it.
    expect(await screen.findByRole("button", { name: /select resource J-1/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /all resources/i })).toBeInTheDocument()
  })

  it("deselects from the wide layout, restoring the cross-resource timeline", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("button", { name: /all resources/i }))
    await waitFor(() => expect(window.location.search).not.toContain("resource="))
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

describe("WorktreeDetailPage wide layout", () => {
  it("keeps the resource list mounted across a selection toggle", async () => {
    // The layout changes shape with the selection: nothing selected gives the
    // resources the full width with the timeline stacked below, a selection
    // splits into list + detail. Both states are ONE Grid with different
    // spans, precisely so the list keeps its position in the React tree — a
    // container swap would remount it, dropping its scroll position and
    // flickering on every click.
    setViewport("wide")
    const user = userEvent.setup()
    wrap()

    const card = await screen.findByRole("button", { name: /select resource o\/r#1/i })
    expect(card.isConnected).toBe(true)

    await user.click(card)
    await waitFor(() => expect(window.location.search).toContain("resource=pr%3A"))
    // Same DOM node, still in the document: not a re-created list.
    expect(card.isConnected).toBe(true)

    await user.click(card)
    await waitFor(() => expect(window.location.search).not.toContain("resource="))
    expect(card.isConnected).toBe(true)
  })

  it("shows the resources and the cross-resource timeline together when nothing is selected", async () => {
    setViewport("wide")
    wrap()
    // The timeline is no longer beside the list, but it must still be on the
    // page — stacked beneath the full-width resources.
    expect(await screen.findByRole("button", { name: /select resource o\/r#1/i })).toBeInTheDocument()
    expect(await screen.findByText(/timeline/i)).toBeInTheDocument()
  })
})

describe("WorktreeDetailPage narrow layout", () => {
  it("shows the timeline under the resources when nothing is selected", async () => {
    // Narrow used to drop the cross-resource timeline entirely, which made it
    // a lesser view rather than a narrower one. With nothing selected both
    // widths now render the same thing: resources, then the timeline.
    setViewport("narrow")
    wrap()
    expect(await screen.findByRole("button", { name: /select resource o\/r#1/i })).toBeInTheDocument()
    expect(await screen.findByText(/timeline/i)).toBeInTheDocument()
  })

  it("still drills down to the resource when one is selected", async () => {
    // The one layout that replaces the list outright — there is no room for a
    // navigator beside the resource at this width.
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("narrow")
    wrap()
    expect(await screen.findByRole("button", { name: /all resources/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /select resource o\/r#1/i })).toBeNull()
  })
})

describe("WorktreeDetailPage scroll model", () => {
  // The mobile payoff depends on the DOCUMENT scrolling: browsers hide the
  // address bar only when the page itself scrolls, never when the scrolling
  // happens in a nested element. And sticky positioning dies silently under
  // ANY scrolling ancestor — no error, the header just stops sticking.
  //
  // jsdom cannot lay anything out, but it faithfully reports inline styles,
  // so the invariant is testable even though the appearance is not.
  const scrolls = (el: HTMLElement) =>
    ["overflow", "overflowY", "overflowX"].some((prop) => {
      const v = el.style[prop as "overflow"]
      return v !== "" && v !== "visible"
    })

  it("puts no scroll container between the page body and the document", async () => {
    // Anchored at the Grid, not the header: the header's SIBLINGS are what
    // trap the scroll, and an ancestor walk from the header would miss them.
    // Everything the page scrolls lives under this Grid, so its ancestor chain
    // is the one that must stay clean all the way up.
    setViewport("wide")
    wrap()
    await waitFor(() => expect(screen.getByRole("button", { name: "Hide details" })).toBeInTheDocument())

    const grid = document.querySelector<HTMLElement>(".mantine-Grid-root")
    expect(grid, "expected the layout Grid").toBeTruthy()

    const offenders: string[] = []
    for (let el = grid!.parentElement; el; el = el.parentElement) {
      if (scrolls(el)) offenders.push(el.style.cssText)
    }
    expect(offenders).toEqual([])
  })

  it("still renders a sticky header", async () => {
    setViewport("wide")
    wrap()
    await waitFor(() => expect(screen.getByRole("button", { name: "Hide details" })).toBeInTheDocument())
    const header = [...document.querySelectorAll<HTMLElement>("div")]
      .find((el) => el.style.position === "sticky")
    expect(header, "expected a sticky header").toBeTruthy()
  })

  it("does not pin the page to the viewport height", async () => {
    // `height: 100dvh` on the shell is what made the page own its scrolling.
    setViewport("wide")
    wrap()
    await waitFor(() => expect(screen.getByRole("button", { name: "Hide details" })).toBeInTheDocument())
    const heights = [...document.querySelectorAll<HTMLElement>("div")]
      .map((el) => el.style.height)
      .filter((h) => h.includes("dvh") || h.includes("vh"))
    expect(heights).toEqual([])
  })
})
