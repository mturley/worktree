import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, renderHook, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { SearchSummary } from "./SearchSummary"
import { NarrowingContext, type Narrowing } from "./NarrowingContext"
import { useUnreadOnly } from "../../hooks/useUnreadOnly"

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)
afterEach(() => {
  cleanup()
  window.history.replaceState({}, "", "/")
  window.localStorage.clear()
})

describe("SearchSummary", () => {
  // A search is on unless a test says otherwise.
  beforeEach(() => window.history.replaceState({}, "", "/?q=x"))

  it("counts in the plural", () => {
    wrap(<SearchSummary count={3} noun={["worktree", "worktrees"]} />)
    expect(screen.getByTestId("search-summary").textContent).toBe("3 worktrees match your search. Clear search Esc")
  })
  it("counts in the singular", () => {
    wrap(<SearchSummary count={1} noun={["worktree", "worktrees"]} />)
    expect(screen.getByTestId("search-summary").textContent).toContain("1 worktree matches your search.")
  })
  it("says N+ when there are more pages", () => {
    wrap(<SearchSummary count={1} more noun={["event", "events"]} />)
    expect(screen.getByTestId("search-summary").textContent).toContain("1+ events match your search.")
  })
  it("names a qualifier after the noun", () => {
    wrap(<SearchSummary count={0} noun={["worktree", "worktrees"]} qualifier="with unread events" />)
    expect(screen.getByTestId("search-summary").textContent)
      // The link follows the Unreads only store, which is off here.
      .toBe("0 worktrees with unread events match your search. Clear search Esc")
  })
  it("with no search, describes what Unreads only leaves", () => {
    window.history.replaceState({}, "", "/")
    const unread = renderHook(() => useUnreadOnly())
    act(() => unread.result.current[1](true))
    wrap(<SearchSummary count={3} noun={["worktree", "worktrees"]} qualifier="with unread events" />)
    expect(screen.getByTestId("search-summary").textContent).toBe("3 worktrees with unread events. See everything Esc")
  })

  it("says Clear search while Unreads only is off, See everything while it's on", () => {
    const unread = renderHook(() => useUnreadOnly())
    wrap(<SearchSummary count={2} noun={["event", "events"]} />)
    expect(screen.getByTestId("search-summary").textContent).toBe("2 events match your search. Clear search Esc")
    act(() => unread.result.current[1](true))
    expect(screen.getByTestId("search-summary").textContent).toBe("2 events match your search. See everything Esc")
  })

  it("See everything clears the search and turns Unreads only off", async () => {
    window.history.replaceState({}, "", "/?q=oauth")
    const unread = renderHook(() => useUnreadOnly())
    act(() => unread.result.current[1](true))
    wrap(<SearchSummary count={0} noun={["event", "events"]} />)
    await userEvent.click(screen.getByRole("button", { name: "See everything" }))
    expect(new URLSearchParams(window.location.search).has("q")).toBe(false)
    expect(unread.result.current[0]).toBe(false)
  })
})

describe("SearchSummary with the page's narrowing (filters)", () => {
  const withPage = (n: Partial<Narrowing>, ui: React.ReactNode) =>
    wrap(
      <NarrowingContext.Provider value={{ search: false, unread: false, filters: false, clearAll: () => {}, ...n }}>
        {ui}
      </NarrowingContext.Provider>,
    )

  it("filters only: match your filters, Clear filters", () => {
    withPage({ filters: true }, <SearchSummary count={4} noun={["event", "events"]} filtered />)
    expect(screen.getByTestId("search-summary").textContent).toBe("4 events match your filters. Clear filters Esc")
  })
  it("search and filters: match your search and filters, See everything", () => {
    withPage({ search: true, filters: true }, <SearchSummary count={4} noun={["event", "events"]} filtered />)
    expect(screen.getByTestId("search-summary").textContent)
      .toBe("4 events match your search and filters. See everything Esc")
  })
  it("Unreads only and filters", () => {
    withPage({ unread: true, filters: true }, <SearchSummary count={2} noun={["unread event", "unread events"]} filtered />)
    expect(screen.getByTestId("search-summary").textContent).toBe("2 unread events match your filters. See everything Esc")
  })
  it("a pane the page's filters don't narrow still names only what does", () => {
    // Filters are on elsewhere on the page, so the link clears more than one thing.
    withPage({ search: true, filters: true }, <SearchSummary count={3} noun={["resource", "resources"]} />)
    expect(screen.getByTestId("search-summary").textContent)
      .toBe("3 resources match your search. See everything Esc")
  })
  it("the link runs the page's clear-everything", async () => {
    const clearAll = vi.fn()
    withPage({ filters: true, clearAll }, <SearchSummary count={0} noun={["event", "events"]} filtered />)
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(clearAll).toHaveBeenCalled()
  })
})
