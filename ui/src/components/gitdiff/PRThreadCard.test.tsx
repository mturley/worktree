import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PRRefDTO, PRThread, ResourceDTO } from "../../api/types"

const markProps = vi.hoisted(() => ({ last: undefined as undefined | { onMarked?: () => void } }))
vi.mock("../MarkAllReadButton", () => ({
  MarkAllReadButton: (props: { onMarked?: () => void }) => {
    markProps.last = props
    return <button>Mark all read</button>
  },
}))

import { REVIEW_SIDEBAR_KEY, REVIEW_SIDEBAR_TAB_KEY } from "../../hooks/useReviewSidebar"
import { PRThreadCard } from "./PRThreadCard"

const pr: PRRefDTO = { id: "o/r#12", number: 12, url: "https://github.com/o/r/pull/12" }
const thread = (over: Partial<PRThread> = {}): PRThread => ({
  id: "t1",
  resolved: false,
  outdated: false,
  file: "src/a.ts",
  side: "new",
  start_line: 3,
  end_line: 3,
  view: { status: "shown", start_line: 3, end_line: 3 },
  comments: [
    { id: 1, author: "octo", body: "first body", created_at: "2026-10-01T00:00:00Z", url: "https://github.com/o/r/pull/12#c1", pending: false },
    { id: 2, author: "cat", body: "reply body", created_at: "2026-10-01T01:00:00Z", url: "https://github.com/o/r/pull/12#c2", pending: false },
  ],
  ...over,
})
const resource = { type: "pr", id: "o/r#12" } as ResourceDTO

function renderCard(props: Partial<React.ComponentProps<typeof PRThreadCard>> = {}) {
  const qc = new QueryClient()
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <PRThreadCard path="/w" thread={thread()} pr={pr} variant="inline" unreadIds={new Set()} {...props} />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  markProps.last = undefined
})
afterEach(cleanup)

describe("PRThreadCard", () => {
  it("shows the author line and a GitHub link", () => {
    renderCard()
    expect(screen.getByText("@octo on PR #12")).toBeTruthy()
    const link = screen.getAllByRole("link", { name: "View on GitHub" })[0]
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/pull/12#c1")
    expect(link.getAttribute("target")).toBe("_blank")
  })

  it("View all opens the sidebar on the PR tab", async () => {
    renderCard()
    await userEvent.click(screen.getByRole("button", { name: "View all" }))
    expect(window.sessionStorage.getItem(REVIEW_SIDEBAR_KEY)).toBe("true")
    expect(window.sessionStorage.getItem(REVIEW_SIDEBAR_TAB_KEY)).toBe("pr")
  })

  it("sidebar variant has no View all", () => {
    renderCard({ variant: "sidebar", onJump: vi.fn() })
    expect(screen.queryByText("View all")).toBeNull()
    expect(screen.getByText("src/a.ts:3")).toBeTruthy()
  })

  it("renders replies", () => {
    renderCard()
    expect(screen.getByText("reply body")).toBeTruthy()
    expect(screen.getByText("@cat on PR #12")).toBeTruthy()
  })

  it("marks pending and outdated", () => {
    const t = thread({ outdated: true })
    t.comments[0].pending = true
    renderCard({ thread: t })
    expect(screen.getByText("Pending")).toBeTruthy()
    expect(screen.getByText("Outdated")).toBeTruthy()
  })

  it("unread shows a dot and the mark button", () => {
    renderCard({ unreadIds: new Set([2]), prResource: resource })
    expect(screen.getAllByRole("img", { name: "unread comment" })).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeTruthy()
  })

  it("no button when nothing is unread", () => {
    renderCard({ prResource: resource })
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull()
  })

  it("puts Mark all read on the first comment's header row, beside its links", () => {
    renderCard({ unreadIds: new Set([2]), prResource: resource })
    const header = screen.getByRole("link", { name: "View on GitHub" }).parentElement!
    expect(header.contains(screen.getByRole("button", { name: "Mark all read" }))).toBe(true)
  })

  it("keeps the same header slots whether or not anything is unread, so the card never grows", () => {
    const slots = () => ({
      mark: document.querySelectorAll("[data-mark-read-slot]").length,
      dots: document.querySelectorAll("[data-unread-slot]").length,
    })
    const { unmount } = renderCard({ prResource: resource })
    const read = slots()
    unmount()
    renderCard({ unreadIds: new Set([1, 2]), prResource: resource })
    expect(slots()).toEqual(read)
    expect(read).toEqual({ mark: 1, dots: 2 })
  })

  it("shows a comment's images as links, never loading them", () => {
    const t = thread()
    t.comments[0].body = "see ![shot](https://example.com/pixel.png)"
    const { container } = renderCard({ thread: t })
    expect(container.querySelector("img")).toBeNull()
    const link = screen.getByRole("link", { name: "shot" })
    expect(link.getAttribute("href")).toBe("https://example.com/pixel.png")
    expect(link.getAttribute("target")).toBe("_blank")
  })

  it("resolved starts collapsed and expands", async () => {
    renderCard({ thread: thread({ resolved: true }) })
    const line = screen.getByRole("button", { name: /Resolved · @octo · src\/a\.ts:3 — first body/ })
    expect(screen.queryByText("reply body")).toBeNull()
    await userEvent.click(line)
    expect(screen.getByText("reply body")).toBeTruthy()
  })

  it("frame border is grape", () => {
    const { container } = renderCard()
    const frame = container.querySelector("[data-pr-thread-id]") as HTMLElement
    expect(frame.style.borderLeft).toContain("grape")
  })

  it("unavailable thread is outdated with the jump disabled", () => {
    renderCard({ variant: "sidebar", onJump: vi.fn(), thread: thread({ view: { status: "unavailable" } }) })
    expect(screen.getByText("Outdated")).toBeTruthy()
    expect((screen.getByRole("button", { name: /Jump to comment/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
