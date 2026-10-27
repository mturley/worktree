import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { act, fireEvent, render, cleanup, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { TaskModalProvider } from "../components/tasks/modal/TaskModalProvider"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ResourceDTO, Task } from "../api/types"
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
const summaryMock = vi.hoisted(() => ({ hasUnread: false }))
vi.mock("../hooks/useWorktrees", () => ({
  useWorktrees: () => ({
    data: [{
      path: "/wt/foo", repo: "odh", branch: "feature/foo-branch", has_unread: summaryMock.hasUnread,
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

// The drill-down is lazy and pulls in pierre; the page only decides when it
// shows and what replaces it, so stand it in.
vi.mock("../components/gitdiff/DiffView", () => ({
  default: ({ headerHeight, escHint, sidebarEscHint }: { headerHeight: number; escHint?: boolean; sidebarEscHint?: boolean }) => (
    <div data-testid="diff-view" data-header={headerHeight} data-esc-hint={String(escHint)} data-sidebar-esc-hint={String(sidebarEscHint)}>
      <textarea aria-label="comment editor" onKeyDown={(e) => { if (e.key === "Escape") e.stopPropagation() }} />
    </div>
  ),
}))

import { setViewport } from "../testing/viewport"
import { WorktreeDetailPage } from "./WorktreeDetailPage"

// The header card (WorktreeDetailCard) fetches /api/worktree-info, so the
// page now needs a QueryClient. A fresh one per render keeps tests isolated.
const wrap = () =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TaskModalProvider><WorktreeDetailPage /></TaskModalProvider>
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
  summaryMock.hasUnread = false
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

  it("marks the title with a static dot only while this worktree has unreads", async () => {
    setViewport("wide")
    const view = wrap()
    await screen.findByRole("heading", { name: "foo", level: 4 })
    expect(screen.queryByRole("img", { name: "worktree has unreads" })).not.toBeInTheDocument()
    view.unmount()

    summaryMock.hasUnread = true
    wrap()
    const title = await screen.findByRole("heading", { name: "foo", level: 4 })
    const dot = screen.getByRole("img", { name: "worktree has unreads" })
    expect(title.parentElement).toContainElement(dot)
  })

  it("puts the unread dot on the cmux workspace title when there is one", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({
      available: true,
      matches: { "/wt/foo": [{ ref: "workspace:1", title: "My workspace", color: "#AD1457", selected: false }] },
    })
    summaryMock.hasUnread = true
    setViewport("wide")
    wrap()
    const workspace = await screen.findByRole("heading", { name: "My workspace", level: 4 })
    const dots = screen.getAllByRole("img", { name: "worktree has unreads" })
    expect(dots).toHaveLength(1)
    expect(workspace.parentElement).toContainElement(dots[0])
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

  it("moves the card under the header for Environment, and back for Notes", async () => {
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("tab", { name: "Environment" }))
    const env = screen.getByRole("tab", { name: "Environment" })
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
    await user.click(await screen.findByRole("tab", { name: "Environment" }))
    expect(screen.getByRole("tab", { name: "Environment" }).closest("[data-page-header]")).not.toBeNull()
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
    await user.click(await screen.findByRole("tab", { name: "Environment" }))
    expect(screen.getByRole("tab", { name: "Environment" }).closest("[data-page-header]")).toBeNull()
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
    await screen.findByRole("tab", { name: "Activity" })
    const header = document.querySelector<HTMLElement>("[data-activity-header]")!
    expect(header.style.position).toBe("sticky")
    expect(header).toContainElement(screen.getByRole("tab", { name: "Activity" }))
    cleanup()

    setViewport("wide", { tall: false })
    wrap()
    await screen.findByRole("tab", { name: "Activity" })
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
  it("backs out with Esc: deselects first, then leaves for the listing", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("wide")
    wrap()
    await screen.findByRole("tab", { name: /Activity/ })
    fireEvent.keyDown(document.body, { key: "Escape" })
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("resource")).toBe(false))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
    fireEvent.keyDown(document.body, { key: "Escape" })
    await waitFor(() => expect(window.location.pathname).toBe("/"))
  })

  it("hints Esc on whatever it will do next", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("wide")
    wrap()
    const back = await screen.findByRole("button", { name: /^← all resources/ })
    const backHome = () => screen.getByRole("link", { name: "All worktrees" })
    // A selection: the hint is beside "← all resources", not on the logo.
    expect(back.parentElement!.querySelector("kbd")?.textContent).toBe("Esc")
    expect(backHome().querySelector("kbd")).toBeNull()

    fireEvent.keyDown(document.body, { key: "Escape" })
    // Nothing left but leaving, and no banner: the logo carries it.
    await waitFor(() => expect(backHome().querySelector("kbd")?.textContent).toBe("Esc"))
  })

  it("leaves for the tab's home worktree on Esc when this is another one", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?home=${encodeURIComponent("/wt/home")}`)
    setViewport("wide")
    wrap()
    await screen.findByRole("heading", { name: "foo", level: 4 })
    fireEvent.keyDown(document.body, { key: "Escape" })
    await waitFor(() => expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/home")}`))
  })

  it("leaves for the listing on Esc when the home banner was dismissed", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?home=${encodeURIComponent("/wt/home")}`)
    window.sessionStorage.setItem("worktree.banner.dismissed.home", "1")
    setViewport("wide")
    wrap()
    await screen.findByRole("heading", { name: "foo", level: 4 })
    fireEvent.keyDown(document.body, { key: "Escape" })
    await waitFor(() => expect(window.location.pathname).toBe("/"))
  })

  it("stays on its own home worktree on Esc, with no Esc hint", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?home=${encodeURIComponent("/wt/foo")}`)
    setViewport("wide")
    wrap()
    await screen.findByRole("heading", { name: "foo", level: 4 })
    fireEvent.keyDown(document.body, { key: "Escape" })
    await new Promise((r) => setTimeout(r, 0))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
    expect(screen.getByRole("link", { name: "All worktrees" }).querySelector("kbd")).toBeNull()
  })

  it("leaves its own home worktree for the listing on Esc once the home banner is dismissed", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?home=${encodeURIComponent("/wt/foo")}`)
    window.sessionStorage.setItem("worktree.banner.dismissed.home", "1")
    setViewport("wide")
    wrap()
    await screen.findByRole("heading", { name: "foo", level: 4 })
    fireEvent.keyDown(document.body, { key: "Escape" })
    await waitFor(() => expect(window.location.pathname).toBe("/"))
  })

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
    await user.click(await screen.findByRole("tab", { name: "Environment" }))
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
    await user.click(await screen.findByRole("tab", { name: "Environment" }))
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
    const heading = screen.getByRole("tab", { name: "Activity" })
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

  it("shows no Resources tab: the feed column's own tab bar is Activity alone", async () => {
    setViewport("wide")
    wrap()
    await screen.findByRole("button", { name: /select resource o\/r#1/i })
    expect(screen.queryByRole("tab", { name: "Resources" })).not.toBeInTheDocument()
    const bar = within(document.querySelector<HTMLElement>("[data-activity-header]")!).getByRole("tablist")
    const tabs = within(bar).getAllByRole("tab")
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Activity"])
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
    // The tab names the feed; its header carries the feed's controls.
    expect(screen.getByTestId("activity-controls")).toBeVisible()
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

  it.each(["wide", "narrow"] as const)("puts Switch cmux right before the search bar (%s)", async (viewport) => {
    vi.spyOn(api, "cmux").mockResolvedValue({
      available: true,
      matches: { "/wt/foo": [{ ref: "workspace:1", title: "My workspace", color: "#AD1457", selected: false }] },
    })
    setViewport(viewport)
    wrap()
    const cmux = await screen.findByRole("button", { name: "Switch cmux" })
    const box = screen.getByRole("searchbox")
    expect(cmux.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Open in editor moved to the Code tab.
    expect(document.querySelector("[data-detail-header]")).not.toHaveTextContent(/Open in editor/i)
    expect(document.querySelector("[data-detail-toolbar]") ?? document.body).not.toHaveTextContent(/Open in editor/i)
    vi.restoreAllMocks()
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
    expect(lines()).toContain("1 resource matches your search. Clear search")
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
    expect(lines()).toContain("0 resources with unread events match your search. See everything")
    await waitFor(() => expect(lines()).toContain("0 unread events match your search. See everything"))
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
      .toContain("1 event matches your search. Clear search"))
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
      .toContain("0 resources match your search. Clear search")
    expect(screen.queryByText(/Nothing matches/)).toBeNull()
    expect(screen.queryByText("No resources tracked.")).toBeNull()
  })

  it("leaves an empty searched feed blank under its 0 line", async () => {
    setViewport("wide")
    window.history.replaceState({}, "", url("q=zzzz"))
    wrap()
    await waitFor(() => expect(screen.getAllByTestId("search-summary").map((n) => n.textContent))
      .toContain("0 events match your search. Clear search"))
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

describe("WorktreeDetailPage diff drill-down", () => {
  const diffUrl = (extra = "") => `/worktree/${encodeURIComponent("/wt/foo")}?diff${extra}`

  it("replaces the details card and the resources with the diff view, keeping the header", async () => {
    window.history.replaceState({}, "", diffUrl())
    setViewport("wide")
    wrap()
    expect(await screen.findByTestId("diff-view")).toBeInTheDocument()
    expect(screen.getByRole("searchbox")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Delete worktree" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /select resource o\/r#1/i })).not.toBeInTheDocument()
  })

  it("closes from the titles, along with their other resets, in one navigation", async () => {
    window.history.replaceState({}, "", diffUrl("&file=a.go&resource=pr:o%2Fr%231&q=w"))
    setViewport("wide")
    wrap()
    await screen.findByTestId("diff-view")
    await userEvent.click(screen.getByTitle("Show all resources"))
    await waitFor(() => expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument())
    const params = new URLSearchParams(window.location.search)
    expect(params.has("diff")).toBe(false)
    expect(params.has("file")).toBe(false)
    expect(params.has("resource")).toBe(false)
    // The search isn't one of the titles' resets.
    expect(params.get("q")).toBe("w")
    expect(await screen.findByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true")
  })

  it("makes the titles a way out even with nothing else to reset", async () => {
    window.history.replaceState({}, "", diffUrl())
    setViewport("wide")
    wrap()
    await screen.findByTestId("diff-view")
    await userEvent.click(screen.getByTitle("Show notes"))
    await waitFor(() => expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument())
  })

  describe("with the review sidebar open", () => {
    beforeEach(() => { window.sessionStorage.setItem("worktree.reviewSidebar", "true") })
    afterEach(() => { window.sessionStorage.removeItem("worktree.reviewSidebar") })

    it("Esc closes the review sidebar before leaving the diff", async () => {
      window.history.replaceState({}, "", diffUrl())
      setViewport("wide")
      wrap()
      await screen.findByTestId("diff-view")
      fireEvent.keyDown(document.body, { key: "Escape" })
      await waitFor(() => expect(window.sessionStorage.getItem("worktree.reviewSidebar")).toBe("false"))
      expect(screen.getByTestId("diff-view")).toBeInTheDocument()
      expect(new URLSearchParams(window.location.search).has("diff")).toBe(true)
      fireEvent.keyDown(document.body, { key: "Escape" })
      await waitFor(() => expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument())
    })

    it("only the sidebar's Esc hint shows while it is open", async () => {
      window.history.replaceState({}, "", diffUrl())
      setViewport("wide")
      wrap()
      const view = await screen.findByTestId("diff-view")
      expect(view.dataset.escHint).toBe("false")
      expect(view.dataset.sidebarEscHint).toBe("true")
      fireEvent.keyDown(document.body, { key: "Escape" })
      await waitFor(() => expect(screen.getByTestId("diff-view").dataset.escHint).toBe("true"))
      expect(screen.getByTestId("diff-view").dataset.sidebarEscHint).toBe("false")
    })

    it("Esc in a comment editor does not close the sidebar or leave", async () => {
      window.history.replaceState({}, "", diffUrl())
      setViewport("wide")
      wrap()
      const editor = await screen.findByLabelText("comment editor")
      editor.focus()
      fireEvent.keyDown(editor, { key: "Escape" })
      expect(window.sessionStorage.getItem("worktree.reviewSidebar")).toBe("true")
      expect(screen.getByTestId("diff-view")).toBeInTheDocument()
    })
  })

  it("goes back to the worktree on Esc, staying on the page", async () => {
    window.history.replaceState({}, "", diffUrl("&file=a.go"))
    setViewport("wide")
    wrap()
    await screen.findByTestId("diff-view")
    fireEvent.keyDown(document.body, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument())
    const params = new URLSearchParams(window.location.search)
    expect(params.has("diff")).toBe(false)
    expect(params.has("file")).toBe(false)
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
  })

  it("leaves the drill-down when typing in the header search, keeping the query", async () => {
    window.history.replaceState({}, "", diffUrl())
    setViewport("wide")
    wrap()
    await screen.findByTestId("diff-view")
    await userEvent.type(screen.getByRole("searchbox"), "w")
    await waitFor(() => expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument())
    const params = new URLSearchParams(window.location.search)
    expect(params.has("diff")).toBe(false)
    expect(params.get("q")).toBe("w")
  })
})

describe("WorktreeDetailPage Esc back to Notes", () => {
  const at = (query = "") => window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}${query}`)
  // The card opens on Notes; pick the tab the way the user does.
  const onTab = async (name: string | RegExp) => userEvent.click(await screen.findByRole("tab", { name }))
  const notesTab = () => screen.getByRole("tab", { name: "Notes" })
  const esc = () => fireEvent.keyDown(document.body, { key: "Escape" })

  it("returns the card to Notes from the Environment tab before deselecting", async () => {
    at("?resource=pr:o%2Fr%231")
    setViewport("wide")
    wrap()
    await onTab("Environment")
    expect(await screen.findByRole("tab", { name: "Environment" })).toHaveAttribute("aria-selected", "true")
    esc()
    await waitFor(() => expect(notesTab()).toHaveAttribute("aria-selected", "true"))
    // Only the tab: the selection is the next Esc's.
    expect(new URLSearchParams(window.location.search).has("resource")).toBe(true)
    esc()
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("resource")).toBe(false))
  })

  it("returns the card to Notes from the Code tab", async () => {
    at()
    setViewport("wide")
    wrap()
    await onTab(/Code/)
    expect(await screen.findByRole("tab", { name: /Code/ })).toHaveAttribute("aria-selected", "true")
    esc()
    await waitFor(() => expect(notesTab()).toHaveAttribute("aria-selected", "true"))
    // Still on the worktree: leaving was not this Esc's.
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
  })

  it("returns the card to Notes from the cmux tab", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: true, matches: {} })
    at()
    setViewport("wide")
    wrap()
    await onTab("cmux")
    await waitFor(() => expect(screen.getByRole("tab", { name: "cmux" })).toHaveAttribute("aria-selected", "true"))
    esc()
    await waitFor(() => expect(notesTab()).toHaveAttribute("aria-selected", "true"))
    vi.restoreAllMocks()
  })

  it("leaves the diff drill-down first, then returns the card to Notes", async () => {
    at("?diff")
    setViewport("wide")
    wrap()
    await screen.findByTestId("diff-view")
    esc()
    await waitFor(() => expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument())
    expect(await screen.findByRole("tab", { name: /Code/ })).toHaveAttribute("aria-selected", "true")
    esc()
    await waitFor(() => expect(notesTab()).toHaveAttribute("aria-selected", "true"))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
  })

  it("comes after clearing a search, which Esc always does first", async () => {
    at("?q=widget")
    setViewport("wide")
    wrap()
    await onTab("Environment")
    esc()
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("q")).toBe(false))
    expect(screen.getByRole("tab", { name: "Environment" })).toHaveAttribute("aria-selected", "true")
    esc()
    await waitFor(() => expect(notesTab()).toHaveAttribute("aria-selected", "true"))
  })

  it("clears a search in the diff drill-down before leaving it, hinting Esc only in the bar", async () => {
    at("?diff&q=widget")
    setViewport("wide")
    wrap()
    await screen.findByTestId("diff-view")
    // DiffView is stubbed here; it shows its breadcrumb's hint by this prop.
    const crumbHint = () => screen.getByTestId("diff-view").dataset.escHint
    expect(screen.getByTestId("search-esc-hint")).toBeInTheDocument()
    expect(crumbHint()).toBe("false")
    esc()
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("q")).toBe(false))
    expect(screen.getByTestId("diff-view")).toBeInTheDocument()
    expect(screen.queryByTestId("search-esc-hint")).toBeNull()
    expect(crumbHint()).toBe("true")
    esc()
    await waitFor(() => expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument())
  })

  it("on Notes, Esc does what it did before: clears the search", async () => {
    at("?q=widget")
    setViewport("wide")
    wrap()
    await screen.findByRole("tab", { name: "Notes" })
    esc()
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("q")).toBe(false))
    expect(notesTab()).toHaveAttribute("aria-selected", "true")
  })

  it("keeps Esc in the search bar for the search", async () => {
    at("?q=widget")
    setViewport("wide")
    wrap()
    await onTab("Environment")
    await screen.findByRole("tab", { name: "Environment" })
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" })
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("q")).toBe(false))
    expect(screen.getByRole("tab", { name: "Environment" })).toHaveAttribute("aria-selected", "true")
  })

  it("hints Esc in one place at a time: the search bar, then the Notes tab", async () => {
    at("?resource=pr:o%2Fr%231&q=widget")
    setViewport("wide")
    wrap()
    await onTab("Environment")
    const lines = () => screen.queryAllByTestId("search-summary").map((n) => n.textContent)
    const back = () => screen.getByRole("button", { name: /^← all resources/ })
    // A query: only the bar hints Esc.
    expect(screen.getByTestId("search-esc-hint")).toBeInTheDocument()
    expect(notesTab().querySelector("kbd")).toBeNull()
    expect(lines().length).toBeGreaterThan(0)
    for (const line of lines()) expect(line).not.toMatch(/Esc$/)
    expect(back().parentElement!.querySelector("kbd")).toBeNull()

    esc()
    // Cleared: the Notes tab is next, and only it hints.
    await waitFor(() => expect(notesTab().querySelector("kbd")?.textContent).toBe("Esc"))
    // The tab's accessible name is still just "Notes" (the key is decorative).
    expect(notesTab()).toHaveAccessibleName("Notes")
    expect(screen.queryByTestId("search-esc-hint")).toBeNull()
    expect(back().parentElement!.querySelector("kbd")).toBeNull()
    expect(screen.getByRole("link", { name: "All worktrees" }).querySelector("kbd")).toBeNull()

    esc()
    // On Notes the hint moves on to deselecting.
    await waitFor(() => expect(notesTab().querySelector("kbd")).toBeNull())
    expect(back().parentElement!.querySelector("kbd")?.textContent).toBe("Esc")
  })

  it("moves the hint from the Notes tab to the logo when leaving is next", async () => {
    at()
    setViewport("wide")
    wrap()
    await onTab("Environment")
    await screen.findByRole("tab", { name: "Environment" })
    const backHome = () => screen.getByRole("link", { name: "All worktrees" })
    await waitFor(() => expect(notesTab().querySelector("kbd")).not.toBeNull())
    expect(backHome().querySelector("kbd")).toBeNull()
    esc()
    await waitFor(() => expect(backHome().querySelector("kbd")?.textContent).toBe("Esc"))
    expect(notesTab().querySelector("kbd")).toBeNull()
  })

  it("shows no Notes-tab hint on Notes", async () => {
    at()
    setViewport("wide")
    wrap()
    expect((await screen.findByRole("tab", { name: "Notes" })).querySelector("kbd")).toBeNull()
  })
})

describe("WorktreeDetailPage tasks", () => {
  const task: Task = {
    id: 5, ref: "T5", title: "Tidy the branch", description: "", state: "not_started", priority: "none", starred: false,
    rank: "r1", created_at: "", updated_at: "", archived: false, links: [], implicit_worktrees: [],
    subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, open_blockers: [],
  }
  const activityHeader = () => document.querySelector<HTMLElement>("[data-activity-header]")!
  /** jsdom has no layout: make the capped list read as overflowing. */
  const mockOverflow = () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 500 })
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 240 })
  }
  beforeEach(() => {
    vi.spyOn(api, "tasks").mockResolvedValue([task])
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  })

  it("wide: the panel scrolls with the page above the pinned activity header, with the worktree's list", async () => {
    setViewport("wide")
    wrap()
    const header = activityHeader()
    const panel = screen.getByTestId("tasks-panel")
    expect(panel).toHaveAttribute("data-level", "normal")
    expect(await within(panel).findByText("Tidy the branch")).toBeInTheDocument()
    expect(api.tasks).toHaveBeenCalledWith({ kind: "worktree", path: "/wt/foo" }, expect.anything())
    expect(header.style.position).toBe("sticky")
    expect(header).toHaveAttribute("data-tooltip-layer", "pinned")
    expect(header).not.toContainElement(panel)
    // Not in the page header either: nothing sticky carries it.
    expect(panel.closest("[style*=sticky]")).toBeNull()
    const bar = within(header).getByRole("tablist")
    expect(panel.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(bar).getByTestId("activity-controls")).toBeInTheDocument()
    expect(within(bar).queryByLabelText("Sort tasks")).toBeNull()
  })

  it("wide: the activity header stays pinned in every level; a selection and back resets expanded", async () => {
    setViewport("wide")
    mockOverflow()
    const user = userEvent.setup()
    wrap()
    const panel = screen.getByTestId("tasks-panel")
    await user.click(await within(panel).findByRole("button", { name: /^Show all \(/ }))
    expect(screen.getByTestId("tasks-panel")).toHaveAttribute("data-level", "expanded")
    expect(activityHeader().style.position).toBe("sticky")
    expect(activityHeader()).toHaveAttribute("data-tooltip-layer", "pinned")
    expect(activityHeader()).not.toContainElement(screen.getByTestId("tasks-panel"))

    // Selecting a resource changes the panel's scope, not the path.
    await user.click(screen.getByRole("button", { name: /select resource o\/r#1/i }))
    await screen.findByRole("tab", { name: /Linked Resources/ })
    expect(screen.getByTestId("tasks-panel")).toHaveAttribute("data-level", "normal")
    await user.click(screen.getByRole("button", { name: /^← all resources/ }))
    await waitFor(() => expect(document.querySelector("[data-activity-header]")).not.toBeNull())
    expect(screen.getByTestId("tasks-panel")).toHaveAttribute("data-level", "normal")
    expect(activityHeader().style.position).toBe("sticky")
  })

  it("narrow: the panel sits above Resources · Activity", async () => {
    setViewport("narrow")
    wrap()
    const resourcesTab = await screen.findByRole("tab", { name: "Resources" })
    const bar = resourcesTab.closest<HTMLElement>("[role=tablist]")!
    expect(within(bar).getAllByRole("tab").map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Resources", "Activity"])
    const panel = screen.getByTestId("tasks-panel")
    expect(await within(panel).findByText("Tidy the branch")).toBeInTheDocument()
    expect(panel.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("a selected resource's pane shows that resource's tasks, not the worktree's tab bar", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("wide")
    wrap()
    await screen.findByRole("tab", { name: /Linked Resources/ })
    expect(document.querySelector("[data-activity-header]")).toBeNull()
    await waitFor(() => expect(api.tasks).toHaveBeenCalledWith({ kind: "resource", type: "pr", id: "o/r#1" }, expect.anything()))
  })
})
