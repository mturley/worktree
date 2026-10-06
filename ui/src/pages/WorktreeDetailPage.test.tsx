import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { act, render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ResourceDTO } from "../api/types"
import { api } from "../api/client"

const baseResources: ResourceDTO[] = [
  { type: "pr", id: "o/r#1", url: "https://gh/pr/1", primary: true, title: "Fix the widget", state: "OPEN" } as ResourceDTO,
  { type: "jira", id: "J-1", url: "https://jira/J-1", primary: true, title: "Investigate flux", status: "In Progress" } as ResourceDTO,
]
// Reassigned by tests that need unread state; reset before each.
let resources = baseResources

const detailArgs = vi.hoisted(() => [] as unknown[][])
vi.mock("../hooks/useWorktreeDetail", () => ({
  useWorktreeDetail: (...args: unknown[]) => (detailArgs.push(args), {
    resources: { data: resources, refetch: vi.fn() },
    timeline: { events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false },
  }),
}))
// Return a summary whose path matches the route, so the page can render its
// WorktreeCard header (spec item 3).
vi.mock("../hooks/useWorktrees", () => ({
  useWorktrees: () => ({
    data: [{
      path: "/wt/foo", repo: "odh", branch: "feature/foo-branch",
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

beforeEach(() => {
  window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}`)
  window.localStorage.clear()
  resources = baseResources
})
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

  it("titles the page with the worktree name, not the branch", async () => {
    setViewport("wide")
    wrap()
    expect(await screen.findByRole("heading", { name: "foo", level: 4 })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "feature/foo-branch", level: 4 })).not.toBeInTheDocument()
  })

  it("shows the cmux workspace and its switch control in the header", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({
      available: true,
      matches: { "/wt/foo": [{ ref: "workspace:1", title: "My workspace", color: "#AD1457", selected: false }] },
    })
    setViewport("wide")
    wrap()
    expect(await screen.findByRole("heading", { name: "My workspace", level: 4 })).toBeInTheDocument()
    // The workspace heads the header and the worktree name steps down.
    const workspace = screen.getByRole("heading", { name: "My workspace", level: 4 })
    const worktree = screen.getByRole("heading", { name: "foo", level: 6 })
    expect(workspace.compareDocumentPosition(worktree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const header = worktree.closest("[data-detail-header]")
    expect(header).toContainElement(screen.getByRole("button", { name: /switch cmux/i }))
    vi.restoreAllMocks()
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
    expect(screen.getByLabelText("Delete worktree")).toBeVisible()
  })

  it("hides the summary card on demand, freeing the space for the resources", async () => {
    setViewport("wide")
    wrap()
    await userEvent.click(await screen.findByRole("button", { name: "Hide details" }))
    expect(screen.getByLabelText("Delete worktree")).not.toBeVisible()
    // The toggle names the state it will move to, so it reads as an action.
    expect(screen.getByRole("button", { name: "Show details" })).toBeInTheDocument()
  })

  it("brings it back on a second click", async () => {
    setViewport("wide")
    wrap()
    await userEvent.click(await screen.findByRole("button", { name: "Hide details" }))
    await userEvent.click(screen.getByRole("button", { name: "Show details" }))
    expect(screen.getByLabelText("Delete worktree")).toBeVisible()
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
  it("renders the resource list as the page body, with no page-level tabs", async () => {
    setViewport("wide")
    wrap()
    // Slack threads are now selected like any other resource, so the
    // Overview/Slack tab split is gone entirely.
    expect(await screen.findByRole("button", { name: /select resource o\/r#1/i })).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Overview" })).not.toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Slack" })).not.toBeInTheDocument()
  })
})

// Mantine writes a Grid.Col's span into a generated <style> rule keyed by a
// per-instance class, not into the element's inline style, so jsdom only
// sees it there. Returns that rule's --col-flex-basis.
function colBasis(col: HTMLElement): string | undefined {
  const cls = [...col.classList].find((c) => c.startsWith("__m__-"))
  if (!cls) return undefined
  for (const style of document.querySelectorAll("style")) {
    const text = style.textContent ?? ""
    if (!text.includes(`.${cls}`)) continue
    const m = text.match(/--col-flex-basis:\s*([^;]+);/)
    if (m) return m[1].trim()
  }
  return undefined
}

describe("WorktreeDetailPage wide layout", () => {
  it("keeps the resource list mounted across a selection toggle", async () => {
    // The right-hand column changes with the selection: nothing selected
    // shows the worktree's activity feed, a selection shows that resource's
    // detail. Both states are ONE Grid with different
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

  it("puts the activity feed beside the resources when nothing is selected", async () => {
    // Wide has room for both, so the worktree's unified feed sits in the
    // right-hand column — where a selected resource's detail would go —
    // rather than being stacked out of sight beneath the resource list.
    setViewport("wide")
    wrap()
    const card = await screen.findByRole("button", { name: /select resource o\/r#1/i })
    const heading = screen.getByRole("heading", { name: "Activity" })
    const listCol = card.closest<HTMLElement>(".mantine-Grid-col")
    const feedCol = heading.closest<HTMLElement>(".mantine-Grid-col")
    expect(listCol).toBeTruthy()
    expect(feedCol).toBeTruthy()
    expect(listCol).not.toBe(feedCol)
    // The list is sticky beside the feed just as it is beside a selection;
    // only a column with something next to it is sticky.
    expect(listCol!.style.position).toBe("sticky")
    // Same filter toggles as the home page's feed.
    expect(screen.getByRole("button", { name: /jira/i })).toBeInTheDocument()
  })

  it("splits evenly with nothing selected, and narrows the list for a selection", async () => {
    // The feed and the list are peers, so they share the width; a selected
    // resource's detail carries more, so it takes two thirds.
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    const card = await screen.findByRole("button", { name: /select resource o\/r#1/i })
    const listCol = card.closest<HTMLElement>(".mantine-Grid-col")!
    expect(colBasis(listCol)).toBe("50%")

    await user.click(card)
    await waitFor(() => expect(window.location.search).toContain("resource=pr%3A"))
    expect(colBasis(listCol)).toMatch(/^33\.33/)
  })

  it("shows no Resources/Activity tab bar", async () => {
    setViewport("wide")
    wrap()
    await screen.findByRole("button", { name: /select resource o\/r#1/i })
    expect(screen.queryByRole("tab", { name: "Resources" })).not.toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Activity" })).not.toBeInTheDocument()
  })
})

describe("WorktreeDetailPage narrow layout", () => {
  it("offers the resources and the activity feed as tabs when nothing is selected", async () => {
    // Stacked, the feed would sit far below the resource list; tabs keep
    // both one tap away, as on the home page.
    setViewport("narrow")
    const user = userEvent.setup()
    wrap()
    const resourcesTab = await screen.findByRole("tab", { name: "Resources" })
    expect(resourcesTab).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("button", { name: /select resource o\/r#1/i })).toBeVisible()

    await user.click(screen.getByRole("tab", { name: "Activity" }))
    expect(screen.getByRole("heading", { name: "Activity" })).toBeVisible()
    expect(screen.getByRole("button", { name: /jira/i })).toBeInTheDocument()
  })

  it("returns to the tab you left when backing out of a drill-down", async () => {
    setViewport("narrow")
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("tab", { name: "Activity" }))

    // Select a resource (as a feed row's resource chip would) to drill down.
    act(() => {
      window.history.pushState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    })
    await user.click(await screen.findByRole("button", { name: /all resources/i }))

    expect(await screen.findByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true")
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

describe("WorktreeDetailPage unread-only toggle", () => {
  it("narrows the worktree's activity feed to unread events, and remembers it", async () => {
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    const toggle = await screen.findByRole("switch", { name: "Show unreads only" })
    expect(toggle).not.toBeChecked()
    expect(detailArgs.at(-1)?.[2]).toBe(false)
    await user.click(toggle)
    expect(detailArgs.at(-1)?.[2]).toBe(true)
    expect(window.localStorage.getItem("worktree.unreadOnly")).toBe("true")
  })

  it("sits beside Follow resource, so it stays offered beside a selected resource", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    resources = [{ ...baseResources[0], unread_count: 1 }, baseResources[1]]
    setViewport("wide")
    wrap()
    await screen.findByRole("button", { name: /all resources/i })
    const toggle = screen.getByRole("switch", { name: "Show unreads only" })
    const follow = screen.getByRole("button", { name: /Follow resource/ })
    expect(follow.parentElement).toContainElement(toggle)
  })

  it("hides resources without unread events", async () => {
    window.localStorage.setItem("worktree.unreadOnly", "true")
    resources = [{ ...baseResources[0], unread_count: 2 }, baseResources[1]]
    setViewport("wide")
    wrap()
    expect(await screen.findByText(/Fix the widget/)).toBeInTheDocument()
    expect(screen.queryByText(/Investigate flux/)).not.toBeInTheDocument()
  })

  it("says so when no resource has unread events", async () => {
    window.localStorage.setItem("worktree.unreadOnly", "true")
    setViewport("wide")
    wrap()
    expect(await screen.findByText("No resources with unread events")).toBeInTheDocument()
  })

  it("deselects a selected resource once it has nothing unread", async () => {
    window.localStorage.setItem("worktree.unreadOnly", "true")
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("wide")
    wrap()
    await waitFor(() => expect(window.location.search).toBe(""))
  })
})
