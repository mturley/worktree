import { afterEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { UnreadBadge } from "./UnreadBadge"

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)
afterEach(cleanup)

describe("UnreadBadge", () => {
  it("renders nothing when there is nothing unread", () => {
    wrap(<UnreadBadge unread={false} count={0} />)
    expect(screen.queryByText(/unread/)).toBeNull()
  })

  it("says 'unread' with no number when the count is unknown", () => {
    // Slack threads are unread without a countable tally behind them, so the
    // badge must not claim "0 unreads".
    wrap(<UnreadBadge unread count={0} />)
    expect(screen.getByText("unread")).toBeInTheDocument()
  })

  it("counts, and agrees with itself about plurals", () => {
    wrap(<UnreadBadge unread count={1} />)
    expect(screen.getByText("1 unread")).toBeInTheDocument()
    cleanup()
    wrap(<UnreadBadge unread count={7} />)
    expect(screen.getByText("7 unreads")).toBeInTheDocument()
  })

  it("stays hidden when unread is false even with a stale count", () => {
    // The flag is the authority; a count left over from a previous render
    // must never resurrect the badge.
    wrap(<UnreadBadge unread={false} count={5} />)
    expect(screen.queryByText(/unread/)).toBeNull()
  })
})
