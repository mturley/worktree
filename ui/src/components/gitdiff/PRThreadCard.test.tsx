import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PRCommentsSummary, PRRefDTO, PRThread, ResourceDTO } from "../../api/types"

const markProps = vi.hoisted(() => ({ last: undefined as undefined | { onMarked?: () => void } }))
vi.mock("../MarkAllReadButton", () => ({
  MarkAllReadButton: (props: { onMarked?: () => void }) => {
    markProps.last = props
    return <button>Mark all read</button>
  },
}))

const apiMock = vi.hoisted(() => ({
  prComments: vi.fn(),
  prWriteReply: vi.fn(),
}))
vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return { ...actual, api: { ...actual.api, ...apiMock } }
})

import { HttpError } from "../../api/client"
import { REVIEW_SIDEBAR_KEY, REVIEW_SIDEBAR_TAB_KEY } from "../../hooks/useReviewSidebar"
import { PRThreadCard } from "./PRThreadCard"

const pr: PRRefDTO = { id: "o/r#12", number: 12, url: "https://github.com/o/r/pull/12", title: "PR title" }
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
  const r = render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <PRThreadCard path="/w" thread={thread()} pr={pr} variant="inline" unreadIds={new Set()} {...props} />
      </QueryClientProvider>
    </MantineProvider>,
  )
  // A positive signal that the PR summary has landed.
  const summaryLoaded = () =>
    waitFor(() => expect(qc.getQueryState(["pr-comments", props.path ?? "/w"])?.status).toBe("success"))
  return { ...r, summaryLoaded }
}

const summary = (over: Partial<PRCommentsSummary> = {}): PRCommentsSummary => ({
  state: "ok",
  pr,
  open_threads: 1,
  unread_comments: 0,
  unread_ids: [],
  pending_comments: 0,
  ...over,
})

// As the server answers with the GitHub watcher off: the PR when it can be
// told without GitHub, and no counts.
const offSummary = (p?: PRCommentsSummary["pr"]): PRCommentsSummary => ({
  state: "off",
  pr: p,
  open_threads: 0,
  unread_comments: 0,
  unread_ids: [],
  pending_comments: 0,
})

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.prComments.mockResolvedValue(summary())
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

  it.each([
    ["outdated", "Out of date: its lines aren't in this view"],
    ["not_in_view", "Not in this view: its file has no changes in the selected commits"],
  ] as const)("a %s thread can't jump, and says why", async (status, why) => {
    const onJump = vi.fn()
    renderCard({ variant: "sidebar", onJump, thread: thread({ view: { status } }) })
    const jumpLink = screen.getByRole("button", { name: /Jump to comment/ }) as HTMLButtonElement
    expect(jumpLink.disabled).toBe(true)
    await userEvent.hover(jumpLink.parentElement as HTMLElement)
    expect(await screen.findByText(why)).toBeInTheDocument()
  })

  it("a shown thread can jump", async () => {
    const onJump = vi.fn()
    renderCard({ variant: "sidebar", onJump, thread: thread({ view: { status: "shown", start_line: 3, end_line: 3 } }) })
    await userEvent.click(screen.getByRole("button", { name: /Jump to comment/ }))
    expect(onJump).toHaveBeenCalled()
  })

  describe("Reply", () => {
    it("opens the editor with the PR review and reply-now choices", async () => {
      renderCard({ path: "/w-r1" })
      await userEvent.click(await screen.findByRole("button", { name: "Reply" }))
      expect(screen.getByRole("textbox")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Start a PR review on #12" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Reply on PR #12" })).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /local/ })).toBeNull()
      await userEvent.type(screen.getByRole("textbox"), "x")
      await userEvent.hover(screen.getByRole("button", { name: "Reply on PR #12" }))
      expect(await screen.findByText("Post this reply on PR #12 now. Everyone can see it.")).toBeInTheDocument()
    })

    it("names the pending review once there is one", async () => {
      apiMock.prComments.mockResolvedValue(summary({ pending_comments: 1 }))
      renderCard({ path: "/w-r2" })
      await userEvent.click(await screen.findByRole("button", { name: "Reply" }))
      expect(await screen.findByRole("button", { name: "Add to PR review #12" })).toBeInTheDocument()
    })

    it("posts to the first comment, then closes", async () => {
      apiMock.prWriteReply.mockResolvedValue({ comment_id: 5 })
      renderCard({ path: "/w-r3" })
      await userEvent.click(await screen.findByRole("button", { name: "Reply" }))
      await userEvent.type(screen.getByRole("textbox"), "thanks")
      await userEvent.click(screen.getByRole("button", { name: "Reply on PR #12" }))
      await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull())
      expect(apiMock.prWriteReply).toHaveBeenCalledWith({
        path: "/w-r3",
        thread_id: "t1",
        in_reply_to: 1,
        mode: "single",
        body: "thanks",
      })
    })

    it("the PR review choice replies in the pending review", async () => {
      apiMock.prWriteReply.mockResolvedValue({ comment_id: 5 })
      renderCard({ path: "/w-r4" })
      await userEvent.click(await screen.findByRole("button", { name: "Reply" }))
      await userEvent.type(screen.getByRole("textbox"), "later")
      await userEvent.click(screen.getByRole("button", { name: "Start a PR review on #12" }))
      await waitFor(() => expect(apiMock.prWriteReply).toHaveBeenCalledWith(expect.objectContaining({ mode: "review" })))
    })

    it("a failure shows the error and keeps the text", async () => {
      apiMock.prWriteReply.mockRejectedValue(new HttpError("GitHub said no", 502))
      renderCard({ path: "/w-r5" })
      await userEvent.click(await screen.findByRole("button", { name: "Reply" }))
      await userEvent.type(screen.getByRole("textbox"), "thanks")
      await userEvent.click(screen.getByRole("button", { name: "Reply on PR #12" }))
      expect(await screen.findByText("GitHub said no")).toBeInTheDocument()
      expect(screen.getByRole("textbox")).toHaveValue("thanks")
    })

    it("keeps the typed reply across a remount", async () => {
      const first = renderCard({ path: "/w-r6" })
      await userEvent.click(await screen.findByRole("button", { name: "Reply" }))
      await userEvent.type(screen.getByRole("textbox"), "half")
      first.unmount()
      renderCard({ path: "/w-r6" })
      expect(await screen.findByRole("textbox")).toHaveValue("half")
    })

    it("a resolved thread offers Reply once expanded", async () => {
      renderCard({ path: "/w-r7", thread: thread({ resolved: true }) })
      const collapsed = screen.getByRole("button", { name: /Resolved ·/ })
      expect(screen.queryByRole("button", { name: "Reply" })).toBeNull()
      await userEvent.click(collapsed)
      expect(await screen.findByRole("button", { name: "Reply" })).toBeInTheDocument()
    })

    // Reply follows the card's own PR (from the pinned threads), never the
    // summary, so a poll can't take it away; its choices say why they're off.
    for (const [name, s, why] of [
      ["the summary loses the PR", summary({ state: "no_pr", pr: undefined }), "This worktree has no PR"],
      ["the watcher is off and the PR unknown", offSummary(), "The GitHub watcher is off"],
      ["a poll errors with no PR", summary({ state: "error", pr: undefined, message: "GitHub is down" }), "GitHub is down"],
    ] as const) {
      it(`Reply stays when ${name}, its choices disabled with why`, async () => {
        apiMock.prComments.mockResolvedValue(s)
        const { summaryLoaded } = renderCard({ path: `/w-r8-${name}` })
        await summaryLoaded()
        await userEvent.click(screen.getByRole("button", { name: "Reply" }))
        await userEvent.type(screen.getByRole("textbox"), "x")
        const b = screen.getByRole("button", { name: "Reply on PR #12" })
        expect(b).toHaveAttribute("aria-disabled", "true")
        await userEvent.hover(b)
        expect(await screen.findByText(why)).toBeInTheDocument()
      })
    }

    // GitHub refuses a single reply while the viewer has a pending review.
    for (const [name, s, t] of [
      ["it has pending comments", summary({ pending_comments: 2 }), thread()],
      ["it is on an older commit", summary({ stale_pending_commit: "abc1234" }), thread()],
      [
        "the thread shows a pending comment",
        summary(),
        thread({
          comments: [
            { id: 1, author: "me", body: "b", created_at: "2026-10-01T00:00:00Z", url: "u", pending: true },
          ],
        }),
      ],
    ] as const) {
      it(`Reply on PR is disabled while a pending review is known: ${name}`, async () => {
        apiMock.prComments.mockResolvedValue(s)
        const { summaryLoaded } = renderCard({ path: `/w-rp-${name}`, thread: t })
        await summaryLoaded()
        await userEvent.click(screen.getByRole("button", { name: "Reply" }))
        await userEvent.type(screen.getByRole("textbox"), "x")
        const b = screen.getByRole("button", { name: "Reply on PR #12" })
        expect(b).toHaveAttribute("aria-disabled", "true")
        await userEvent.click(b)
        expect(apiMock.prWriteReply).not.toHaveBeenCalled()
        await userEvent.hover(b)
        expect(
          await screen.findByText("You have a pending review on PR #12; add to it or submit it first"),
        ).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "Add to PR review #12" })).not.toHaveAttribute("aria-disabled", "true")
      })
    }

    it("with the watcher off, Reply is there but both choices say why they're off", async () => {
      apiMock.prComments.mockResolvedValue(offSummary(pr))
      renderCard({ path: "/w-r9" })
      await userEvent.click(await screen.findByRole("button", { name: "Reply" }))
      await userEvent.type(screen.getByRole("textbox"), "x")
      for (const name of ["Start a PR review on #12", "Reply on PR #12"]) {
        const b = screen.getByRole("button", { name })
        expect(b).toHaveAttribute("aria-disabled", "true")
        await userEvent.click(b)
        await userEvent.hover(b)
        expect(await screen.findByText("The GitHub watcher is off")).toBeInTheDocument()
        await userEvent.unhover(b)
        await waitFor(() => expect(screen.queryByText("The GitHub watcher is off")).toBeNull())
      }
      expect(apiMock.prWriteReply).not.toHaveBeenCalled()
    })

    it("an open reply survives the summary turning off, its text kept", async () => {
      const r = renderCard({ path: "/w-r10" })
      await userEvent.click(await screen.findByRole("button", { name: "Reply" }))
      await userEvent.type(screen.getByRole("textbox"), "typing")
      apiMock.prComments.mockResolvedValue(summary({ state: "error", message: "GitHub is down" }))
      r.unmount()
      const again = renderCard({ path: "/w-r10" })
      await again.summaryLoaded()
      expect(screen.getByRole("textbox")).toHaveValue("typing")
      const b = screen.getByRole("button", { name: "Reply on PR #12" })
      expect(b).toHaveAttribute("aria-disabled", "true")
      await userEvent.hover(b)
      expect(await screen.findByText("GitHub is down")).toBeInTheDocument()
    })
  })
})
