import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { act, fireEvent, render, cleanup, screen, waitFor, within } from "@testing-library/react"
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
let events: unknown[] = []

const detailArgs = vi.hoisted(() => [] as unknown[][])
vi.mock("../hooks/useWorktreeDetail", () => ({
  useWorktreeDetail: (...args: unknown[]) => (detailArgs.push(args), {
    resources: { data: resources, refetch: vi.fn() },
    timeline: { events, isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false },
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
// The worktree's own feed comes from useWorktreeDetail above; this one only
// backs a selected resource's feed and the mark-all-read preview.
const timelineMock = vi.hoisted(() => ({ events: [] as unknown[] }))
vi.mock("../hooks/useTimeline", () => ({
  useWorktreeTimeline: () => ({ events: timelineMock.events, isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false }),
}))

// Stood in so the Slack event tests can see what the thread was asked to
// focus, without the thread renderer's internals.
vi.mock("../components/slack/ThreadView", () => ({
  ThreadView: ({ focus }: { focus?: { ts: string } }) => (
    <div data-testid="thread-view">{`focus ${focus?.ts ?? "none"}`}</div>
  ),
}))
vi.mock("../hooks/useThread", () => ({
  useThread: () => ({ data: undefined, status: "ready", error: undefined, refresh: vi.fn(), applyLocal: vi.fn() }),
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
  // The details card's tab is remembered per browser tab.
  window.sessionStorage.clear()
  resources = baseResources
  events = []
  timelineMock.events = []
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

  it("moves the header toolbar to its own row when narrow", async () => {
    setViewport("narrow")
    wrap()
    await screen.findByRole("button", { name: "Delete worktree" })
    const toolbar = document.querySelector("[data-detail-toolbar]")
    expect(toolbar).toBeInTheDocument()
    // Beside the titles it squeezed them to a few letters per line.
    expect(toolbar!.closest("[data-detail-header]")).toBeNull()
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
    setViewport("wide")
    wrap()
    await screen.findByRole("button", { name: "Delete worktree" })
    expect(screen.getByRole("tab", { name: "Notes" })).toBeVisible()
  })




  it("puts the delete control in the details card, not the header toolbar", async () => {
    setViewport("wide")
    wrap()
    const del = await screen.findByRole("button", { name: "Delete worktree" })
    expect(del.closest("[data-detail-toolbar]")).toBeNull()
    expect(del.closest(".mantine-Paper-root")).toContainElement(screen.getByRole("tab", { name: "Notes" }))
  })
})

describe("WorktreeDetailPage details card placement", () => {
  /** Whether `el` is in the resource column (vs. under the header). */
  const inColumn = (el: HTMLElement) =>
    screen.getByRole("button", { name: /Follow resource/ }).closest(".mantine-Grid-col")!.contains(el)

  it("puts Notes in the resource column, above Follow resource", async () => {
    setViewport("wide")
    wrap()
    const notes = await screen.findByRole("tab", { name: "Notes" })
    expect(inColumn(notes)).toBe(true)
    expect(notes.compareDocumentPosition(
      screen.getByRole("button", { name: /Follow resource/ }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("moves the card under the header for Git / Environment, and back for Notes", async () => {
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("tab", { name: "Git / Environment" }))
    const env = screen.getByRole("tab", { name: "Git / Environment" })
    expect(env).toHaveAttribute("aria-selected", "true")
    expect(inColumn(env)).toBe(false)

    await user.click(screen.getByRole("tab", { name: "Notes" }))
    expect(inColumn(screen.getByRole("tab", { name: "Notes" }))).toBe(true)
  })

  it("has no toggle, and keeps the card under the header when narrow", async () => {
    // No side column to put Notes in.
    setViewport("narrow")
    wrap()
    const notes = await screen.findByRole("tab", { name: "Notes" })
    expect(notes).toBeVisible()
    expect(notes.closest(".mantine-Grid-col")).toBeNull()
    expect(screen.queryByRole("button", { name: /(Collapse|Expand) details/ })).toBeNull()
  })
})

describe("WorktreeDetailPage pinned cards", () => {
  /** The nearest pinned (position: sticky) ancestor of `el`, if any. */
  const pinned = (el: HTMLElement) => el.closest<HTMLElement>('[style*="sticky"]')

  it("pins the expanded details card with the header when wide and tall", async () => {
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("tab", { name: "Git / Environment" }))
    expect(screen.getByRole("tab", { name: "Git / Environment" }).closest("[data-page-header]")).not.toBeNull()
  })

  it("keeps scrolled content off the toolbar when narrow, without moving it at rest", () => {
    setViewport("narrow")
    wrap()
    const header = document.querySelector<HTMLElement>("[data-page-header]")!
    expect(header.style.paddingBottom).toBe("var(--mantine-spacing-sm)")
    expect(header.style.marginBottom).toBe("calc(-1 * var(--mantine-spacing-sm))")
  })

  it("lets the expanded details card scroll away when short", async () => {
    setViewport("wide", { tall: false })
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("tab", { name: "Git / Environment" }))
    expect(screen.getByRole("tab", { name: "Git / Environment" }).closest("[data-page-header]")).toBeNull()
    // The title row itself stays pinned.
    expect(screen.getByRole("heading", { name: "foo" }).closest("[data-page-header]")).not.toBeNull()
  })

  it("lets the details card scroll away on a phone", async () => {
    setViewport("narrow", { tall: true })
    wrap()
    expect((await screen.findByRole("tab", { name: "Notes" })).closest("[data-page-header]")).toBeNull()
  })

  it("does not pin the notes card in the column when short", async () => {
    setViewport("wide", { tall: false })
    wrap()
    const notes = await screen.findByRole("tab", { name: "Notes" })
    // Its nearest pinned ancestor is the column itself, not a card wrapper.
    expect(pinned(notes)).toBe(notes.closest(".mantine-Grid-col"))
  })

  it("pins the worktree's activity header, with its filters, only when wide and tall", async () => {
    setViewport("wide")
    wrap()
    await screen.findByRole("heading", { name: "Activity" })
    const header = document.querySelector<HTMLElement>("[data-activity-header]")!
    expect(header.style.position).toBe("sticky")
    expect(header).toContainElement(screen.getByRole("heading", { name: "Activity" }))
    cleanup()

    setViewport("wide", { tall: false })
    wrap()
    await screen.findByRole("heading", { name: "Activity" })
    expect(document.querySelector<HTMLElement>("[data-activity-header]")!.style.position).toBe("")
  })

  it("pins a selected resource's card and tabs only when wide and tall", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("wide")
    wrap()
    const activity = await screen.findByRole("tab", { name: /Activity/ })
    expect(pinned(activity)).not.toBeNull()
    cleanup()

    setViewport("wide", { tall: false })
    wrap()
    expect(pinned(await screen.findByRole("tab", { name: /Activity/ }))).toBeNull()
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

  it("deselects when the worktree title is clicked", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("button", { name: "foo" }))
    await waitFor(() => expect(window.location.search).not.toContain("resource="))
  })

  it("returns the details card to Notes when the worktree title is clicked", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("tab", { name: "Git / Environment" }))
    await user.click(await screen.findByRole("button", { name: "foo" }))
    expect(await screen.findByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true")
  })

  it("turns unreads only off when the worktree title is clicked", async () => {
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    const unread = await screen.findByRole("switch", { name: /unread/i })
    await user.click(unread)
    expect(unread).toBeChecked()
    await user.click(await screen.findByRole("button", { name: "foo" }))
    await waitFor(() => expect(unread).not.toBeChecked())
    expect(screen.queryByRole("button", { name: "foo" })).not.toBeInTheDocument()
  })

  it("makes the worktree title clickable when only the card is off Notes", async () => {
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("tab", { name: "Git / Environment" }))
    await user.click(await screen.findByRole("button", { name: "foo" }))
    expect(await screen.findByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true")
    // Nothing left to reset.
    expect(screen.queryByRole("button", { name: "foo" })).not.toBeInTheDocument()
  })

  it("does not make the worktree title clickable with nothing selected", async () => {
    setViewport("wide")
    wrap()
    expect(await screen.findByRole("heading", { name: "foo" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "foo" })).not.toBeInTheDocument()
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
    await screen.findByRole("button", { name: "Delete worktree" })

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
    await screen.findByRole("button", { name: "Delete worktree" })
    const header = [...document.querySelectorAll<HTMLElement>("div")]
      .find((el) => el.style.position === "sticky")
    expect(header, "expected a sticky header").toBeTruthy()
  })

  it("does not pin the page to the viewport height", async () => {
    // `height: 100dvh` on the shell is what made the page own its scrolling.
    setViewport("wide")
    wrap()
    await screen.findByRole("button", { name: "Delete worktree" })
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
    const toggle = await screen.findByRole("switch", { name: "Unreads only" })
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
    const toggle = screen.getByRole("switch", { name: "Unreads only" })
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
    await waitFor(() => expect(screen.getAllByTestId("search-summary").map((n) => n.textContent))
      .toContain("0 resources with unread events. See everything Esc"))
  })

  it("deselects a selected resource once it has nothing unread", async () => {
    window.localStorage.setItem("worktree.unreadOnly", "true")
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("wide")
    wrap()
    await waitFor(() => expect(window.location.search).toBe(""))
  })
})

describe("WorktreeDetailPage event opened from the home page", () => {
  const event = {
    id: "evt-7", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "github",
    type: "pr_comment", type_label: "", title: "Looks good to me", body: "The whole comment body", author: "someone",
    resource_type: "pr", resource_id: "o/r#1", resource_url: "https://gh/pr/1", resource_title: "Fix the widget",
    worktrees: ["foo"], worktree_paths: ["/wt/foo"],
  }
  const url = `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`

  it("opens the event's details over the selected resource", async () => {
    window.history.replaceState({ openEvent: event }, "", url)
    wrap()
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("The whole comment body")
    expect(new URLSearchParams(window.location.search).get("resource")).toBe("pr:o/r#1")
  })

  it("drops the event from history so a reload does not reopen it", async () => {
    window.history.replaceState({ openEvent: event, other: 1 }, "", url)
    wrap()
    await screen.findByRole("dialog")
    expect(window.history.state).toEqual({ other: 1 })
    expect(window.location.pathname + window.location.search).toBe(url)
  })

  it("closes on demand", async () => {
    window.history.replaceState({ openEvent: event }, "", url)
    wrap()
    await screen.findByRole("dialog")
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("opens nothing without one, or with malformed state", async () => {
    window.history.replaceState({ openEvent: { id: 7 } }, "", url)
    wrap()
    await screen.findAllByText("Fix the widget")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("brings a Slack message into view in its thread instead of opening details", async () => {
    resources = [
      ...baseResources,
      { type: "slack", id: "C1:1791500000.000100", url: "https://x.slack.com/archives/C1/p1791500000000100", primary: true } as ResourceDTO,
    ]
    const slackEvent = {
      ...event, source: "slack", type: "slack_reply", external_ts: "1791561570.240519",
      resource_type: "slack", resource_id: "C1:1791500000.000100", resource_url: resources[2].url,
    }
    window.history.replaceState(
      { openEvent: slackEvent },
      "",
      `/worktree/${encodeURIComponent("/wt/foo")}?resource=slack:C1%3A1791500000.000100`,
    )
    wrap()
    expect(await screen.findByTestId("thread-view")).toHaveTextContent("focus 1791561570.240519")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})

describe("WorktreeDetailPage arriving to follow an archived resource", () => {
  const url = `/worktree/${encodeURIComponent("/wt/foo")}`

  it("opens the follow modal with the URL prefilled, and drops the request from history", async () => {
    window.history.replaceState(
      { followResource: { url: "https://gh/pr/77", name: "Old name" }, other: 1 }, "", url,
    )
    wrap()
    const dialog = await screen.findByRole("dialog")
    expect((within(dialog).getByLabelText(/url/i) as HTMLInputElement).value).toBe("https://gh/pr/77")
    expect(window.history.state).toEqual({ other: 1 })
  })

  it("opens nothing for malformed state", async () => {
    window.history.replaceState({ followResource: { url: 5 } }, "", url)
    wrap()
    await screen.findAllByText("Fix the widget")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})

describe("WorktreeDetailPage event clicked in its own activity feed", () => {
  const prEvent = {
    id: "evt-8", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "github",
    type: "pr_comment", type_label: "", title: "Looks good to me", body: "The whole comment body", author: "someone",
    resource_type: "pr", resource_id: "o/r#1", resource_url: "https://gh/pr/1", resource_title: "Fix the widget",
    worktrees: ["foo"], worktree_paths: ["/wt/foo"],
  }
  const slackResource = { type: "slack", id: "C1:1791500000.000100", url: "https://x.slack.com/archives/C1/p1791500000000100", primary: true } as ResourceDTO
  const slackEvent = {
    ...prEvent, id: "evt-9", source: "slack", type: "slack_reply", external_ts: "1791561570.240519",
    resource_type: "slack", resource_id: slackResource.id, resource_url: slackResource.url,
  }

  it("selects the resource and opens the event's details over it", async () => {
    setViewport("wide")
    events = [prEvent]
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByText("Looks good to me"))
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("The whole comment body")
    expect(decodeURIComponent(new URLSearchParams(window.location.search).get("resource") ?? "")).toBe("pr:o/r#1")
  })

  it("selects a Slack thread and brings the message into view, with no details", async () => {
    setViewport("wide")
    resources = [...baseResources, slackResource]
    events = [slackEvent]
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByText("Looks good to me"))
    expect(await screen.findByTestId("thread-view")).toHaveTextContent("focus 1791561570.240519")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})

describe("search", () => {
  const url = (qs: string) => `/worktree/${encodeURIComponent("/wt/foo")}?${qs}`

  it("filters this worktree's resources and keeps the selected one", async () => {
    setViewport("wide")
    resources = [
      ...baseResources,
      { type: "jira", id: "J-2", url: "https://jira/J-2", primary: true, title: "Kumquat proxy", status: "Open" } as ResourceDTO,
    ]
    window.history.replaceState({}, "", url("resource=pr:o%2Fr%231&q=kumquat"))
    wrap()
    expect(screen.getByRole("searchbox")).toHaveValue("kumquat")
    // The match is highlighted, which splits the title across elements.
    expect(document.body.textContent).toContain("Kumquat proxy")
    // Selected but not matching: still listed, still selected.
    expect(screen.getAllByText(/Fix the widget/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Investigate flux/)).not.toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get("resource")).toBe("pr:o/r#1")
  })

  it("passes q to the worktree feed", async () => {
    setViewport("wide")
    window.history.replaceState({}, "", url("q=oauth"))
    wrap()
    await waitFor(() => expect(detailArgs.at(-1)?.[4]).toBe("oauth"))
  })

  it("puts the search bar right after Open in editor", () => {
    setViewport("wide")
    wrap()
    const editor = screen.getByRole("button", { name: /open in editor/i })
    expect(editor.compareDocumentPosition(screen.getByRole("searchbox")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("puts the search bar right after Open in editor when narrow", async () => {
    setViewport("narrow")
    wrap()
    const editor = screen.getByRole("button", { name: /open in editor/i })
    const box = screen.getByRole("searchbox")
    expect(editor.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const del = await screen.findByRole("button", { name: "Delete worktree" })
    expect(box.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("heads the resource list with its match count, leaving out the kept selection", async () => {
    setViewport("wide")
    resources = [
      ...baseResources,
      { type: "jira", id: "J-2", url: "https://jira/J-2", primary: true, title: "Kumquat proxy", status: "Open" } as ResourceDTO,
    ]
    // The selected PR stays listed but does not match, so it is not counted.
    window.history.replaceState({}, "", url("resource=pr:o%2Fr%231&q=kumquat"))
    const user = userEvent.setup()
    wrap()
    const lines = () => screen.queryAllByTestId("search-summary").map((n) => n.textContent)
    expect(lines()).toContain("1 resource matches your search. Clear search Esc")
    await user.click(screen.getAllByRole("button", { name: "Clear search" }).at(-1)!)
    expect(lines()).toEqual([])
    expect(new URLSearchParams(window.location.search).has("q")).toBe(false)
  })

  it("puts each match line directly above its results, below the toggles and filters", async () => {
    setViewport("wide")
    events = [{
      id: "e1", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "jira", type: "jira_comment", type_label: "",
      title: "Kumquat note", body: "", author: "a", resource_type: "jira", resource_id: "J-1", resource_url: "",
      resource_title: "", worktrees: [],
    }]
    window.history.replaceState({}, "", url("q=kumquat"))
    wrap()
    const after = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    const lines = () => screen.getAllByTestId("search-summary")
    const resourceLine = lines().find((n) => /resource/.test(n.textContent ?? ""))!
    expect(after(screen.getByRole("switch", { name: /Notify on all/ }), resourceLine)).toBe(true)
    await waitFor(() => expect(lines().some((n) => /event/.test(n.textContent ?? ""))).toBe(true))
    const eventLine = lines().find((n) => /event/.test(n.textContent ?? ""))!
    const activityHeader = document.querySelector<HTMLElement>("[data-activity-header]")!
    const lastFilter = within(activityHeader).getAllByRole("button").filter((b) => !eventLine.contains(b)).at(-1)!
    expect(after(lastFilter, eventLine)).toBe(true)
  })

  it("heads the resources and the feed with what Unreads only leaves, with no search", async () => {
    setViewport("wide")
    window.history.replaceState({}, "", url(""))
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getAllByRole("switch", { name: "Unreads only" })[0])
    const lines = () => screen.getAllByTestId("search-summary").map((n) => n.textContent)
    expect(lines()).toContain("0 resources with unread events. See everything Esc")
    await waitFor(() => expect(lines()).toContain("0 unread events. See everything Esc"))
    expect(screen.queryByText(/No resources with unread events/)).toBeNull()
    expect(screen.queryByText(/No unread events/)).toBeNull()
  })

  it("Esc turns Unreads only off as well as clearing the search", async () => {
    setViewport("wide")
    window.history.replaceState({}, "", url("q=kumquat"))
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getAllByRole("switch", { name: "Unreads only" })[0])
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.getAllByRole("switch", { name: "Unreads only" })[0]).not.toBeChecked()
    expect(new URLSearchParams(window.location.search).has("q")).toBe(false)
  })

  it("offers See everything while Unreads only is on, which turns the toggle off", async () => {
    setViewport("wide")
    window.history.replaceState({}, "", url(""))
    const user = userEvent.setup()
    wrap()
    const toggle = screen.getAllByRole("switch", { name: "Unreads only" })[0]
    await user.click(toggle)
    await user.click(screen.getAllByRole("button", { name: "See everything" })[0])
    expect(screen.getAllByRole("switch", { name: "Unreads only" })[0]).not.toBeChecked()
  })

  it("says when the match lines count only unread things", async () => {
    setViewport("wide")
    window.history.replaceState({}, "", url("q=kumquat"))
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getAllByRole("switch", { name: "Unreads only" })[0])
    const lines = () => screen.getAllByTestId("search-summary").map((n) => n.textContent)
    expect(lines()).toContain("0 resources with unread events match your search. See everything Esc")
    await waitFor(() => expect(lines()).toContain("0 unread events match your search. See everything Esc"))
  })

  it("counts matching events above the activity filters", async () => {
    setViewport("wide")
    events = [{
      id: "e1", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "jira", type: "jira_comment", type_label: "",
      title: "Kumquat note", body: "", author: "a", resource_type: "jira", resource_id: "J-1", resource_url: "",
      resource_title: "", worktrees: [],
    }]
    window.history.replaceState({}, "", url("q=kumquat"))
    wrap()
    await waitFor(() => expect(screen.queryAllByTestId("search-summary").map((n) => n.textContent))
      .toContain("1 event matches your search. Clear search Esc"))
  })

  it("a source filter heads the resources and the feed with 'match your filters'; its link clears it", async () => {
    setViewport("wide")
    window.history.replaceState({}, "", url(""))
    const user = userEvent.setup()
    wrap()
    expect(screen.queryByTestId("search-summary")).toBeNull()
    await user.click(screen.getByRole("button", { name: /GitHub/ }))
    expect(detailArgs.at(-1)?.[1]).toEqual(["pr"])
    const lines = () => screen.getAllByTestId("search-summary").map((n) => n.textContent)
    expect(lines()).toContain("1 resource matches your filters. Clear filters Esc")
    await waitFor(() => expect(lines()).toContain("0 events match your filters. Clear filters Esc"))
    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0])
    expect(detailArgs.at(-1)?.[1]).toEqual([])
    expect(screen.queryByTestId("search-summary")).toBeNull()
  })

  it("Esc clears the filters too", async () => {
    setViewport("wide")
    window.history.replaceState({}, "", url(""))
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getByRole("button", { name: /GitHub/ }))
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(detailArgs.at(-1)?.[1]).toEqual([])
  })

  it("says 0 match when no resource does, and no other empty text", () => {
    setViewport("wide")
    window.history.replaceState({}, "", url("q=zzzz"))
    wrap()
    expect(screen.getAllByTestId("search-summary").map((n) => n.textContent))
      .toContain("0 resources match your search. Clear search Esc")
    expect(screen.queryByText(/Nothing matches/)).toBeNull()
    expect(screen.queryByText("No resources tracked.")).toBeNull()
  })

  it("leaves an empty searched feed blank under its 0 line", async () => {
    setViewport("wide")
    window.history.replaceState({}, "", url("q=zzzz"))
    wrap()
    await waitFor(() => expect(screen.getAllByTestId("search-summary").map((n) => n.textContent))
      .toContain("0 events match your search. Clear search Esc"))
    expect(screen.queryByText("No events yet.")).toBeNull()
  })
})

describe("WorktreeDetailPage mark all read", () => {
  const unread = () => [
    { ...baseResources[0], unread_count: 1, unread_through_ts: "2026-10-01T00:00:00Z" },
    baseResources[1],
  ] as ResourceDTO[]
  const button = () => screen.queryByRole("button", { name: "Mark all read" })

  it("is offered over the whole feed", () => {
    resources = unread()
    wrap()
    expect(button()).not.toBeNull()
  })

  it("is hidden while searching", () => {
    resources = unread()
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?q=widget`)
    wrap()
    expect(button()).toBeNull()
  })

  it("is hidden while a source filter narrows the feed", async () => {
    resources = unread()
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getByRole("button", { name: /GitHub/ }))
    expect(button()).toBeNull()
  })

  it("a previewed event opens its details over the modal, selecting nothing", async () => {
    resources = unread()
    timelineMock.events = [{
      id: "evt-3", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "github",
      type: "pr_comment", type_label: "", title: "Please take another look", body: "", author: "someone",
      resource_type: "pr", resource_id: "o/r#1", resource_url: "https://gh/pr/1", resource_title: "Fix the widget",
      worktrees: [], unread: true,
    }]
    const user = userEvent.setup()
    wrap()
    await user.click(button()!)
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByText("Please take another look"))
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(2))
    expect(screen.getByRole("dialog", { name: "Mark all read" })).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get("resource")).toBeNull()
  })
})
