import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, renderHook, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { SearchSummary } from "./SearchSummary"
import { ClearFiltersLink } from "./ClearFiltersLink"
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

describe("ClearFiltersLink", () => {
  it("renders nothing when no filter is on", () => {
    wrap(<ClearFiltersLink active={false} onClear={() => {}} />)
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull()
  })
  it("clears when clicked", async () => {
    const onClear = vi.fn()
    wrap(<ClearFiltersLink active onClear={onClear} />)
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(onClear).toHaveBeenCalled()
  })
})
