import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { SearchSummary } from "./SearchSummary"
import { ClearFiltersLink } from "./ClearFiltersLink"

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)
afterEach(cleanup)

describe("SearchSummary", () => {
  it("counts in the plural", () => {
    wrap(<SearchSummary count={3} noun={["worktree", "worktrees"]} onClear={() => {}} />)
    expect(screen.getByTestId("search-summary").textContent).toBe("3 worktrees match your search. Clear search")
  })
  it("counts in the singular", () => {
    wrap(<SearchSummary count={1} noun={["worktree", "worktrees"]} onClear={() => {}} />)
    expect(screen.getByTestId("search-summary").textContent).toContain("1 worktree matches your search.")
  })
  it("says N+ when there are more pages", () => {
    wrap(<SearchSummary count={1} more noun={["event", "events"]} onClear={() => {}} />)
    expect(screen.getByTestId("search-summary").textContent).toContain("1+ events match your search.")
  })
  it("names a qualifier after the noun", () => {
    wrap(<SearchSummary count={0} noun={["worktree", "worktrees"]} qualifier="with unread events" onClear={() => {}} />)
    expect(screen.getByTestId("search-summary").textContent)
      .toBe("0 worktrees with unread events match your search. Clear search")
  })

  it("clears the search", async () => {
    const onClear = vi.fn()
    wrap(<SearchSummary count={0} noun={["event", "events"]} onClear={onClear} />)
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }))
    expect(onClear).toHaveBeenCalled()
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
