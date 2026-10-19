import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AllResourceDTO, TimelineEvent, WorktreeSummary } from "../api/types"
import { api } from "../api/client"
import { AllResourceRow } from "./AllResourceRow"
import { CrossHoverProvider } from "./CrossHoverContext"
import { EventRow } from "./EventRow"
import { ResourceCard } from "./ResourceCard"
import { WorktreeCard } from "./WorktreeCard"

const wt = (path: string, branch: string): WorktreeSummary => ({
  path, repo: "r", branch, on_disk: true, resource_count: 1, primary_count: 1, latest_event_ts: "",
  primary_by_type: {}, related_count: 0, focus_resources: [],
})

const pr: AllResourceDTO = {
  type: "pr", id: "o/r#1", url: "https://github.com/o/r/pull/1", primary: true, title: "Shared PR",
  worktrees: [{ path: "/wt/a", repo: "r", branch: "branch-a" }, { path: "/wt/b", repo: "r", branch: "branch-b" }],
}

const event = (overrides: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: "evt-1", ts: "2026-08-18T00:00:00Z", external_ts: "", source: "github", type: "pr_opened",
  type_label: "PR Opened", title: "Opened it", body: "", author: "", resource_type: "pr", resource_id: "o/r#1",
  resource_url: "", resource_title: "", worktrees: ["branch-a"], worktree_paths: ["/wt/a"], ...overrides,
})

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MantineProvider><CrossHoverProvider>{ui}</CrossHoverProvider></MantineProvider>
    </QueryClientProvider>,
  )

const card = (name: string) => screen.getByRole("link", { name: `open worktree ${name}` }).closest("[data-interactive]")!
// jsdom's PointerEvent drops pointerType, so it is set by hand.
const pointer = (type: string, el: Element, pointerType: string) => {
  const ev = new Event(type, { bubbles: true })
  Object.assign(ev, { pointerType })
  fireEvent(el, ev)
}
const enter = (el: Element, pointerType = "mouse") => pointer("pointerover", el, pointerType)
const leave = (el: Element) => pointer("pointerout", el, "mouse")
const lit = (el: Element) => el.getAttribute("data-cross-hover") === "true"

beforeEach(() => {
  window.history.replaceState({}, "", "/")
  vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
  vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false, tabs: [] } as never)
})
afterEach(() => vi.restoreAllMocks())
afterEach(cleanup)

describe("cross-hover", () => {
  it("lights the worktrees following a hovered resource row, and clears on leave", () => {
    wrap(<>
      <WorktreeCard w={wt("/wt/a", "branch-a")} />
      <WorktreeCard w={wt("/wt/b", "branch-b")} />
      <WorktreeCard w={wt("/wt/c", "branch-c")} />
      <AllResourceRow r={pr} />
    </>)
    const row = screen.getByTestId("all-resource-row")
    enter(row)
    expect([lit(card("a")), lit(card("b")), lit(card("c"))]).toEqual([true, true, false])
    leave(row)
    expect([lit(card("a")), lit(card("b"))]).toEqual([false, false])
  })

  it("lights a hovered event's worktrees, and a hovered worktree's events and resource rows", () => {
    const { container } = wrap(<>
      <WorktreeCard w={wt("/wt/a", "branch-a")} />
      <WorktreeCard w={wt("/wt/b", "branch-b")} />
      <EventRow e={event()} onSelectResource={() => {}} showWorktrees />
      <AllResourceRow r={pr} />
    </>)
    const row = container.querySelector("[data-event-row]")!
    enter(row)
    expect([lit(card("a")), lit(card("b"))]).toEqual([true, false])
    leave(row)

    enter(card("a"))
    expect(lit(row)).toBe(true)
    expect(lit(screen.getByTestId("all-resource-row"))).toBe(true)
    leave(card("a"))
    enter(card("b"))
    expect(lit(row)).toBe(false)
    expect(lit(screen.getByTestId("all-resource-row"))).toBe(true)
  })

  it("leaves out events with nowhere to go", () => {
    const { container } = wrap(<>
      <WorktreeCard w={wt("/wt/a", "branch-a")} />
      {/* No onSelectResource: the row opens its details instead. */}
      <EventRow e={event()} onOpen={() => {}} showWorktrees />
    </>)
    const row = container.querySelector("[data-event-row]")!
    enter(row)
    expect(lit(card("a"))).toBe(false)
    enter(card("a"))
    expect(lit(row)).toBe(false)
  })

  it("pairs a worktree page's resource card with that resource's events", () => {
    const { container } = wrap(<>
      <ResourceCard r={pr} path="/wt/a" onSelect={() => {}} />
      <EventRow e={event()} onSelectResource={() => {}} />
      <EventRow e={event({ id: "evt-2", resource_id: "o/r#2" })} onSelectResource={() => {}} />
    </>)
    const resourceCard = container.querySelector("[data-interactive]")!
    const [mine, other] = container.querySelectorAll("[data-event-row]")
    enter(mine)
    expect(lit(resourceCard)).toBe(true)
    leave(mine)
    enter(resourceCard)
    expect([lit(mine), lit(other)]).toEqual([true, false])
  })

  it("ignores touch, whose emulated hover never ends", () => {
    wrap(<>
      <WorktreeCard w={wt("/wt/a", "branch-a")} />
      <AllResourceRow r={pr} />
    </>)
    enter(screen.getByTestId("all-resource-row"), "touch")
    expect(lit(card("a"))).toBe(false)
  })

  it("lights partners on keyboard focus, and clears on blur", () => {
    const { container } = wrap(<>
      <WorktreeCard w={wt("/wt/a", "branch-a")} />
      <EventRow e={event()} onSelectResource={() => {}} />
    </>)
    const row = container.querySelector("[data-event-row]") as HTMLElement
    const matches = vi.spyOn(row, "matches").mockImplementation((s) => s === ":focus-visible")
    fireEvent.focus(row)
    expect(lit(card("a"))).toBe(true)
    fireEvent.blur(row)
    expect(lit(card("a"))).toBe(false)
    // A mouse click's focus is not focus-visible, and lights nothing.
    matches.mockReturnValue(false)
    fireEvent.focus(row)
    expect(lit(card("a"))).toBe(false)
  })

  it("does nothing outside a provider", () => {
    render(
      <MantineProvider>
        <EventRow e={event()} onSelectResource={() => {}} />
      </MantineProvider>,
    )
    const row = document.querySelector("[data-event-row]")!
    enter(row)
    expect(row.hasAttribute("data-cross-hover")).toBe(false)
  })
})
