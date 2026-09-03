import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, fireEvent } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { TimelineFeed } from "./TimelineFeed"
import type { TimelineEvent } from "../api/types"

const ev = (id: string, o: Partial<TimelineEvent> = {}): TimelineEvent =>
  ({ id, ts: "2026-08-25T00:00:00Z", type: "pr_comment", type_label: "PR comments",
     title: `event ${id}`, body: "", author: "", source: "github", external_ts: "",
     resource_type: "pr", resource_id: "o/r#1", resource_url: "u", resource_title: "",
     worktrees: [], ...o }) as TimelineEvent

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

afterEach(cleanup)

describe("TimelineFeed pagination", () => {
  it("offers Load more and calls back when there are further pages", () => {
    const onLoadMore = vi.fn()
    wrap(
      <TimelineFeed events={[ev("a")]} loading={false} error={null} hasMore onLoadMore={onLoadMore} />,
    )
    fireEvent.click(screen.getByRole("button", { name: /load more/i }))
    expect(onLoadMore).toHaveBeenCalled()
  })

  it("hides Load more on the last page", () => {
    wrap(<TimelineFeed events={[ev("a")]} loading={false} error={null} hasMore={false} onLoadMore={vi.fn()} />)
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument()
  })

  it("hides Load more for feeds that opt out of pagination entirely", () => {
    wrap(<TimelineFeed events={[ev("a")]} loading={false} error={null} />)
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument()
  })

  it("keeps already-loaded events visible while the next page loads", () => {
    // The spinner belongs to the button, not the feed: swapping the whole
    // list for a loader on "load more" would throw away the user's place.
    wrap(
      <TimelineFeed events={[ev("a")]} loading={false} error={null} hasMore onLoadMore={vi.fn()} loadingMore />,
    )
    expect(screen.getByText("event a")).toBeInTheDocument()
  })
})

describe("TimelineFeed unread divider", () => {
  it("draws the divider above the oldest unread event", () => {
    wrap(
      <TimelineFeed
        events={[
          ev("e3", { title: "newest", unread: true }),
          ev("e2", { title: "middle", unread: true }),
          ev("e1", { title: "oldest", unread: false }),
        ]}
        loading={false}
        error={null}
        showUnreadDivider
      />,
    )
    const divider = screen.getByText("New")
    const middle = screen.getByText("middle")
    const oldest = screen.getByText("oldest")
    // The feed is newest-first, so the divider sits after the last unread
    // event and before the first read one.
    expect(middle.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(divider.compareDocumentPosition(oldest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("draws no divider when nothing is unread", () => {
    wrap(<TimelineFeed events={[ev("e1", { unread: false })]} loading={false} error={null} showUnreadDivider />)
    expect(screen.queryByText("New")).not.toBeInTheDocument()
  })

  it("draws no divider on a feed that did not ask for one", () => {
    // A unified feed interleaves resources, so a single line would be a lie.
    wrap(<TimelineFeed events={[ev("e1", { unread: true })]} loading={false} error={null} />)
    expect(screen.queryByText("New")).not.toBeInTheDocument()
  })
})
