import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { ResourceCard } from "../components/ResourceCard"
import { WorktreeCard } from "../components/WorktreeCard"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ResourceDTO, WorktreeSummary } from "../api/types"
import { cardEdgeStyle } from "./unread"

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<MantineProvider><QueryClientProvider client={qc}>{ui}</QueryClientProvider></MantineProvider>)
}
const paper = (c: HTMLElement) => c.querySelector(".mantine-Paper-root") as HTMLElement
afterEach(cleanup)

const res = (o: Partial<ResourceDTO>) =>
  ({ type: "pr", id: "o/r#1", url: "u", primary: true, title: "T", state: "OPEN", ...o }) as ResourceDTO

const wt: WorktreeSummary = {
  path: "/wt/foo", repo: "r", branch: "b", on_disk: true, resource_count: 0,
  primary_count: 0, latest_event_ts: "", primary_by_type: {}, related_count: 0,
  focus_resources: [],
}

/**
 * The invariant, not the colours.
 *
 * Two separate bugs came from emitting `borderColor` beside a side border:
 * a white box left behind on mark-read, and an unread card dropping to grey
 * when deselected. Neither reproduced in jsdom, because its CSSOM resolves
 * shorthand conflicts differently from a browser's — but jsdom DOES faithfully
 * report which properties were written. So test that.
 */
describe("card borders never mix a colour longhand with side shorthands", () => {
  const assertNoBorderColor = (el: HTMLElement) => {
    const style = el.getAttribute("style") ?? ""
    expect(style).not.toMatch(/(^|;)\s*border-color\s*:/)
    // And all four sides are always present, so no state is expressed by the
    // ABSENCE of a property — removal is what the browser resolved wrongly.
    for (const side of ["border-top", "border-right", "border-bottom", "border-left"]) {
      expect(style).toContain(`${side}:`)
    }
  }

  it("holds for every resource-card state", () => {
    for (const unread_count of [0, 3]) {
      for (const selected of [false, true]) {
        const { container } = wrap(
          <ResourceCard r={res({ unread_count })} selected={selected} onSelect={vi.fn()} />,
        )
        assertNoBorderColor(paper(container))
        cleanup()
      }
    }
  })

  it("holds for every worktree-card state", () => {
    for (const has_unread of [false, true]) {
      const { container } = wrap(<WorktreeCard w={{ ...wt, has_unread }} />)
      assertNoBorderColor(paper(container))
      cleanup()
    }
  })

  it("survives select, deselect, and mark-read without losing a side", () => {
    // The reported repro: select an unread card, then select something else.
    // The card must come back to unread blue, not the stylesheet's grey.
    const { container, rerender } = wrap(
      <ResourceCard r={res({ unread_count: 3 })} selected={false} onSelect={vi.fn()} />)
    const unreadEdges = cardEdgeStyle(true, false)

    rerender(
      <MantineProvider>
        <ResourceCard r={res({ unread_count: 3 })} selected onSelect={vi.fn()} />
      </MantineProvider>)
    assertNoBorderColor(paper(container))

    rerender(
      <MantineProvider>
        <ResourceCard r={res({ unread_count: 3 })} selected={false} onSelect={vi.fn()} />
      </MantineProvider>)
    const el = paper(container)
    assertNoBorderColor(el)
    expect(el).toHaveStyle(unreadEdges)
  })
})

describe("cardEdgeStyle", () => {
  it("lets unread win the border and selection keep the background", () => {
    // Orthogonal on purpose: a selected unread card gives up neither signal.
    expect(cardEdgeStyle(true, true)).toEqual(cardEdgeStyle(true, false))
  })

  it("gives a read card a real border rather than the absence of one", () => {
    const read = cardEdgeStyle(false, false)
    expect(read.borderTop).toContain("default-border")
    expect(read.borderLeft).toBe(read.borderTop)
  })
})
