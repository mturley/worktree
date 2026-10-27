import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PRCommentsSummary, ReviewCommentItem } from "../../api/types"

const apiMock = vi.hoisted(() => ({
  createReviewComment: vi.fn(),
  updateReviewComment: vi.fn(),
  deleteReviewComment: vi.fn(),
  reviewComments: vi.fn(),
  prComments: vi.fn(),
  prWriteCheck: vi.fn(),
  prWriteComment: vi.fn(),
}))
vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return { ...actual, api: { ...actual.api, ...apiMock } }
})

import { HttpError } from "../../api/client"
import { useDeletedDrafts } from "../../hooks/useReviewComments"
import { NewCommentCard, ReviewCommentCard } from "./ReviewCommentCard"

const item = (over: Partial<ReviewCommentItem> = {}): ReviewCommentItem => ({
  id: 7,
  source: "draft",
  editable: true,
  file: "src/a.ts",
  side: "new",
  start_line: 3,
  end_line: 5,
  rev: "abc",
  base: "merge-base",
  base_ref: "main",
  snippet: [],
  body: "original",
  version: 2,
  created_at: "",
  updated_at: "",
  prompt: { status: "current", start_line: 3, end_line: 5 },
  view: { status: "shown", start_line: 3, end_line: 5 },
  ...over,
})

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (u: React.ReactNode) => (
    <MantineProvider>
      <QueryClientProvider client={qc}>{u}</QueryClientProvider>
    </MantineProvider>
  )
  const r = render(tree(ui))
  return { ...r, qc, rerender: (u: React.ReactNode) => r.rerender(tree(u)) }
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.reviewComments.mockResolvedValue({ comments: [] })
  apiMock.prComments.mockResolvedValue(summary({ state: "no_pr", pr: undefined }))
  apiMock.prWriteCheck.mockResolvedValue({ review: { postable: true }, single: { postable: true } })
})

const summary = (over: Partial<PRCommentsSummary> = {}): PRCommentsSummary => ({
  state: "ok",
  pr: { id: "o/r#12", number: 12, url: "https://github.com/o/r/pull/12", title: "PR title" },
  open_threads: 0,
  unread_comments: 0,
  unread_ids: [],
  pending_comments: 0,
  ...over,
})
// As the server answers with the GitHub watcher off: the PR when it can be
// told without GitHub, and no counts.
const offSummary = (pr?: PRCommentsSummary["pr"]): PRCommentsSummary => ({
  state: "off",
  pr,
  open_threads: 0,
  unread_comments: 0,
  unread_ids: [],
  pending_comments: 0,
})
afterEach(cleanup)

describe("ReviewCommentCard", () => {
  it("edit saves with the version", async () => {
    apiMock.updateReviewComment.mockResolvedValue({})
    wrap(<ReviewCommentCard path="/w" comment={item()} variant="inline" />)
    await userEvent.click(screen.getByRole("button", { name: "Edit comment" }))
    const box = screen.getByRole("textbox")
    await userEvent.clear(box)
    await userEvent.type(box, "changed")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(apiMock.updateReviewComment).toHaveBeenCalledWith({ path: "/w", id: 7, version: 2, body: "changed" }),
    )
  })

  it("shows newer text and keeps typing on 409", async () => {
    const newer = { ...item(), body: "theirs", version: 3 }
    apiMock.updateReviewComment.mockRejectedValueOnce(new HttpError("conflict", 409, { comment: newer }))
    apiMock.updateReviewComment.mockResolvedValueOnce({})
    wrap(<ReviewCommentCard path="/w" comment={item()} variant="inline" />)
    await userEvent.click(screen.getByRole("button", { name: "Edit comment" }))
    const box = screen.getByRole("textbox")
    await userEvent.clear(box)
    await userEvent.type(box, "mine")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByText("Changed elsewhere — your text is kept below")).toBeInTheDocument()
    expect(screen.getByText("theirs")).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toHaveValue("mine")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(apiMock.updateReviewComment).toHaveBeenLastCalledWith({ path: "/w", id: 7, version: 3, body: "mine" }),
    )
  })

  it("keeps typed text when the comment was deleted elsewhere", async () => {
    apiMock.updateReviewComment.mockRejectedValue(new HttpError("gone", 404))
    const view = wrap(<ReviewCommentCard path="/w" comment={item()} variant="inline" />)
    await userEvent.click(screen.getByRole("button", { name: "Edit comment" }))
    const box = screen.getByRole("textbox")
    await userEvent.clear(box)
    await userEvent.type(box, "mine")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByText("Deleted elsewhere")).toBeInTheDocument()
    expect(screen.getByText("mine")).toBeInTheDocument()
    expect(screen.queryByRole("textbox")).toBeNull()
    // The list drops the comment and the card unmounts; a fresh card still shows it.
    view.unmount()
    wrap(<ReviewCommentCard path="/w" comment={item()} variant="inline" />)
    expect(screen.getByText("Deleted elsewhere")).toBeInTheDocument()
    expect(screen.getByText("mine")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByText("mine")).toBeNull()
  })

  it("saves with the version the edit started from, though a poll brought a newer one", async () => {
    const newer = { ...item(), body: "theirs", version: 3 }
    apiMock.updateReviewComment.mockRejectedValueOnce(new HttpError("conflict", 409, { comment: newer }))
    const view = wrap(<ReviewCommentCard path="/w-base" comment={item()} variant="inline" />)
    await userEvent.click(screen.getByRole("button", { name: "Edit comment" }))
    const box = screen.getByRole("textbox")
    await userEvent.clear(box)
    await userEvent.type(box, "mine")
    // Another client saved meanwhile; the next poll hands the card version 3.
    view.rerender(<ReviewCommentCard path="/w-base" comment={newer} variant="inline" />)
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(apiMock.updateReviewComment).toHaveBeenCalledWith({ path: "/w-base", id: 7, version: 2, body: "mine" }),
    )
    expect(await screen.findByText("Changed elsewhere — your text is kept below")).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toHaveValue("mine")
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
  })

  it("keeps an edit, its text and its start version across a remount", async () => {
    apiMock.updateReviewComment.mockResolvedValue({})
    const first = wrap(<ReviewCommentCard path="/w-remount" comment={item()} variant="inline" />)
    await userEvent.click(screen.getByRole("button", { name: "Edit comment" }))
    const box = screen.getByRole("textbox")
    await userEvent.clear(box)
    await userEvent.type(box, "half typed")
    // pierre remounts the slot when an earlier annotation comes or goes.
    first.unmount()
    wrap(<ReviewCommentCard path="/w-remount" comment={item({ version: 5, body: "polled" })} variant="inline" />)
    expect(screen.getByRole("textbox")).toHaveValue("half typed")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(apiMock.updateReviewComment).toHaveBeenCalledWith({
        path: "/w-remount",
        id: 7,
        version: 2,
        body: "half typed",
      }),
    )
    // Saved: the draft is gone, so a fresh card is not editing.
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull())
    cleanup()
    wrap(<ReviewCommentCard path="/w-remount" comment={item()} variant="inline" />)
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("cancel drops the edit draft", async () => {
    const first = wrap(<ReviewCommentCard path="/w-cancel" comment={item()} variant="inline" />)
    await userEvent.click(screen.getByRole("button", { name: "Edit comment" }))
    await userEvent.type(screen.getByRole("textbox"), " more")
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    first.unmount()
    wrap(<ReviewCommentCard path="/w-cancel" comment={item()} variant="inline" />)
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("an inline edit does not open the sidebar card's editor", async () => {
    wrap(
      <>
        <ReviewCommentCard path="/w-variant" comment={item()} variant="inline" />
        <ReviewCommentCard path="/w-variant" comment={item()} variant="sidebar" />
      </>,
    )
    await userEvent.click(screen.getAllByRole("button", { name: "Edit comment" })[0])
    expect(screen.getAllByRole("textbox")).toHaveLength(1)
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
  })

  it("records the view with a deleted-elsewhere tombstone", async () => {
    apiMock.updateReviewComment.mockRejectedValue(new HttpError("gone", 404))
    const drafts = renderHook(() => useDeletedDrafts("/w-tomb")).result
    wrap(<ReviewCommentCard path="/w-tomb" comment={item()} variant="inline" viewKey="o1..n1" />)
    await userEvent.click(screen.getByRole("button", { name: "Edit comment" }))
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(drafts.current.drafts).toHaveLength(1))
    expect(drafts.current.drafts[0].view).toBe("o1..n1")
    act(() => drafts.current.dismiss(7))
  })

  it.each(["inline", "sidebar"] as const)("delete asks first (%s)", async (variant) => {
    apiMock.deleteReviewComment.mockResolvedValue({})
    wrap(<ReviewCommentCard path="/w" comment={item()} variant={variant} />)
    await userEvent.click(screen.getByRole("button", { name: "Delete comment" }))
    const dialog = await screen.findByRole("dialog", { name: "Delete comment" })
    expect(within(dialog).getByText("Delete the comment on src/a.ts:3-5? This can't be undone.")).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(apiMock.deleteReviewComment).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Delete comment" }))
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(apiMock.deleteReviewComment).toHaveBeenCalledWith("/w", 7))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("a failed delete says why and stays open", async () => {
    apiMock.deleteReviewComment.mockRejectedValue(new Error("boom"))
    wrap(<ReviewCommentCard path="/w" comment={item()} variant="inline" />)
    await userEvent.click(screen.getByRole("button", { name: "Delete comment" }))
    const dialog = await screen.findByRole("dialog", { name: "Delete comment" })
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
    expect(await within(dialog).findByText("boom")).toBeInTheDocument()
  })

  it("out of date badge", () => {
    wrap(<ReviewCommentCard path="/w" comment={item({ view: { status: "outdated" } })} variant="inline" />)
    expect(screen.getByText("Out of date")).toBeInTheDocument()
  })

  it("not in this view note in the sidebar variant", () => {
    const c = item({ view: { status: "not_in_view" } })
    const { container } = wrap(<ReviewCommentCard path="/w" comment={c} variant="sidebar" />)
    expect(screen.getByText("Not in this view")).toBeInTheDocument()
    expect(screen.getByText("src/a.ts:3-5")).toBeInTheDocument()
    expect(container.querySelector('[data-review-comment-id="7"]')).not.toBeNull()
  })

  it("does not show the note or file inline", () => {
    wrap(<ReviewCommentCard path="/w" comment={item({ view: { status: "not_in_view" } })} variant="inline" />)
    expect(screen.queryByText("Not in this view")).toBeNull()
    expect(screen.queryByText("src/a.ts:3-5")).toBeNull()
  })

  it("inline, names the author and opens the sidebar from View all and copy", async () => {
    window.sessionStorage.setItem("worktree.reviewSidebar", "false")
    wrap(<ReviewCommentCard path="/w" comment={item()} variant="inline" />)
    const author = screen.getByText("You (local)")
    await userEvent.hover(author)
    expect(await screen.findByText("Part of your local review, not submitted anywhere.")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "View all and copy" }))
    expect(window.sessionStorage.getItem("worktree.reviewSidebar")).toBe("true")
    // Open, the link has nothing left to do.
    expect(screen.queryByRole("button", { name: "View all and copy" })).not.toBeInTheDocument()
    expect(screen.getByText("You (local)")).toBeInTheDocument()
  })

  it("in the sidebar, has no author line", () => {
    wrap(<ReviewCommentCard path="/w" comment={item()} variant="sidebar" />)
    expect(screen.queryByText("You (local)")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "View all and copy" })).not.toBeInTheDocument()
  })

  it("in the sidebar, the file and lines are the jump", async () => {
    const onJump = vi.fn()
    wrap(<ReviewCommentCard path="/w" comment={item()} variant="sidebar" onJump={onJump} />)
    const place = screen.getByRole("button", { name: "Jump to comment at src/a.ts:3-5" })
    expect(place).toHaveTextContent("src/a.ts:3-5")
    await userEvent.click(place)
    expect(onJump).toHaveBeenCalledTimes(1)
    // No separate jump control.
    expect(screen.getAllByRole("button", { name: /^Jump to comment/ })).toHaveLength(1)
  })

  it("renders the body as Markdown, never as raw HTML", () => {
    wrap(
      <ReviewCommentCard
        path="/w"
        comment={item({ body: "**bold** and `code`\n\n<b>raw</b>" })}
        variant="inline"
      />,
    )
    expect(screen.getByText("bold").tagName).toBe("STRONG")
    expect(screen.getByText("code").tagName).toBe("CODE")
    expect(document.querySelector("b")).toBeNull()
  })

  it("jump disabled with reason", () => {
    wrap(
      <ReviewCommentCard path="/w" comment={item()} variant="sidebar" onJump={vi.fn()} jumpDisabledReason="Not here" />,
    )
    expect(screen.getByRole("button", { name: /^Jump to comment/ })).toBeDisabled()
  })
})

describe("NewCommentCard", () => {
  const target = { file: "src/a.ts", side: "new" as const, start: 4, end: 6 }
  const view = { base: "merge-base" as const, range: "all" as const, oldRev: "o1", newRev: "n1" }

  it("creates with target and view revs", async () => {
    apiMock.createReviewComment.mockResolvedValue({})
    const onDone = vi.fn()
    wrap(<NewCommentCard path="/w" target={target} view={view} onDone={onDone} />)
    await userEvent.type(screen.getByRole("textbox"), "nice")
    await userEvent.click(screen.getByRole("button", { name: "Start local review" }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(apiMock.createReviewComment).toHaveBeenCalledWith({
      path: "/w",
      file: "src/a.ts",
      side: "new",
      start_line: 4,
      end_line: 6,
      body: "nice",
      base: "merge-base",
      old_rev: "o1",
      new_rev: "n1",
    })
  })

  it("starts the review, with a tooltip saying so, when there are no comments", async () => {
    wrap(<NewCommentCard path="/w" target={target} view={view} onDone={() => {}} />)
    await waitFor(() => expect(apiMock.reviewComments).toHaveBeenCalledWith("/w", undefined))
    const submit = screen.getByRole("button", { name: "Start local review" })
    expect(submit).toHaveAttribute("aria-disabled", "true")
    await userEvent.hover(submit)
    expect(await screen.findByText(LOCAL_TIP)).toBeInTheDocument()
    // Empty, a click does nothing.
    await userEvent.click(submit)
    expect(apiMock.createReviewComment).not.toHaveBeenCalled()
  })

  it("adds to the review once there are comments", async () => {
    apiMock.reviewComments.mockResolvedValue({ comments: [item()] })
    wrap(<NewCommentCard path="/w" target={target} view={view} onDone={() => {}} />)
    expect(await screen.findByRole("button", { name: "Add local comment" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Start local review" })).not.toBeInTheDocument()
  })

  it("passes from and to for a commit range", async () => {
    apiMock.createReviewComment.mockResolvedValue({})
    wrap(<NewCommentCard path="/w" target={target} view={{ ...view, range: { from: "a", to: "b" } }} onDone={() => {}} />)
    await userEvent.type(screen.getByRole("textbox"), "x")
    await userEvent.click(screen.getByRole("button", { name: "Start local review" }))
    await waitFor(() =>
      expect(apiMock.createReviewComment).toHaveBeenCalledWith(expect.objectContaining({ from: "a", to: "b" })),
    )
  })

  it("keeps the typed text across a remount, for the same target only", async () => {
    const first = wrap(<NewCommentCard path="/w-new" target={target} view={view} onDone={() => {}} />)
    await userEvent.type(screen.getByRole("textbox"), "half")
    first.unmount()
    const second = wrap(<NewCommentCard path="/w-new" target={target} view={view} onDone={() => {}} />)
    expect(screen.getByRole("textbox")).toHaveValue("half")
    second.unmount()
    const other = wrap(<NewCommentCard path="/w-new" target={{ ...target, start: 1, end: 1 }} view={view} onDone={() => {}} />)
    expect(screen.getByRole("textbox")).toHaveValue("")
    other.unmount()
    // Cancelled, it is gone.
    const third = wrap(<NewCommentCard path="/w-new" target={target} view={view} onDone={() => {}} />)
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    third.unmount()
    wrap(<NewCommentCard path="/w-new" target={target} view={view} onDone={() => {}} />)
    expect(screen.getByRole("textbox")).toHaveValue("")
  })

  it("drops the draft once created", async () => {
    apiMock.createReviewComment.mockResolvedValue({})
    const onDone = vi.fn()
    const first = wrap(<NewCommentCard path="/w-made" target={target} view={view} onDone={onDone} />)
    await userEvent.type(screen.getByRole("textbox"), "nice")
    await userEvent.click(screen.getByRole("button", { name: "Start local review" }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    first.unmount()
    wrap(<NewCommentCard path="/w-made" target={target} view={view} onDone={onDone} />)
    expect(screen.getByRole("textbox")).toHaveValue("")
  })

  it("keeps text on failure", async () => {
    apiMock.createReviewComment.mockRejectedValue(new Error("boom"))
    const onDone = vi.fn()
    wrap(<NewCommentCard path="/w" target={target} view={view} onDone={onDone} />)
    await userEvent.type(screen.getByRole("textbox"), "nice")
    await userEvent.click(screen.getByRole("button", { name: "Start local review" }))
    expect(await screen.findByText("boom")).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toHaveValue("nice")
    expect(onDone).not.toHaveBeenCalled()
  })

  describe("with a PR", () => {
    const enabled = async (name: string) => {
      const b = await screen.findByRole("button", { name })
      await waitFor(() => expect(b).not.toHaveAttribute("aria-disabled", "true"))
      return b
    }

    it("offers local, PR review and comment now, in that order, with no pending review", async () => {
      apiMock.prComments.mockResolvedValue(summary())
      wrap(<NewCommentCard path="/w-pr1" target={target} view={view} onDone={() => {}} />)
      await screen.findByRole("button", { name: "Start a PR review on #12" })
      const names = screen.getAllByRole("button").map((b) => b.textContent)
      expect(names).toEqual(["Start local review", "Start a PR review on #12", "Comment on PR #12", "Cancel"])
      await userEvent.type(screen.getByRole("textbox"), "x")
      await userEvent.hover(await enabled("Start a PR review on #12"))
      expect(
        await screen.findByText(
          "Add this comment to your pending review on PR #12. Only you can see it until you submit the review.",
        ),
      ).toBeInTheDocument()
      await userEvent.hover(await enabled("Comment on PR #12"))
      expect(
        await screen.findByText("Post this comment on PR #12 now, as a single comment everyone can see."),
      ).toBeInTheDocument()
      expect(apiMock.prWriteCheck).toHaveBeenCalledWith("/w-pr1", {
        file: "src/a.ts",
        side: "new",
        start_line: 4,
        end_line: 6,
        old_rev: "o1",
        new_rev: "n1",
      })
    })

    it("adds to the local review and the pending PR review once each exists", async () => {
      apiMock.prComments.mockResolvedValue(summary({ pending_comments: 2 }))
      apiMock.reviewComments.mockResolvedValue({ comments: [item()] })
      wrap(<NewCommentCard path="/w-pr2" target={target} view={view} onDone={() => {}} />)
      expect(await screen.findByRole("button", { name: "Add local comment" })).toBeInTheDocument()
      expect(await screen.findByRole("button", { name: "Add to PR review #12" })).toBeInTheDocument()
    })

    it("without a PR, offers only the local button", async () => {
      const { qc } = wrap(<NewCommentCard path="/w-pr3" target={target} view={view} onDone={() => {}} />)
      await waitFor(() => expect(qc.getQueryState(["pr-comments", "/w-pr3"])?.status).toBe("success"))
      expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Start local review", "Cancel"])
      expect(apiMock.prWriteCheck).not.toHaveBeenCalled()
    })

    it("disables both GitHub buttons with the check's reason", async () => {
      apiMock.prComments.mockResolvedValue(summary())
      apiMock.prWriteCheck.mockResolvedValue({
        review: { postable: false, reason: "on uncommitted changes" },
        single: { postable: false, reason: "on uncommitted changes" },
      })
      wrap(<NewCommentCard path="/w-pr4" target={target} view={view} onDone={() => {}} />)
      await userEvent.type(screen.getByRole("textbox"), "x")
      for (const name of ["Start a PR review on #12", "Comment on PR #12"]) {
        const b = await screen.findByRole("button", { name })
        await waitFor(() => expect(apiMock.prWriteCheck).toHaveBeenCalled())
        expect(b).toHaveAttribute("aria-disabled", "true")
        await userEvent.hover(b)
        expect(await screen.findByText("on uncommitted changes")).toBeInTheDocument()
        await userEvent.click(b)
        await userEvent.unhover(b)
        await waitFor(() => expect(screen.queryByText("on uncommitted changes")).toBeNull())
      }
      expect(apiMock.prWriteComment).not.toHaveBeenCalled()
    })

    it("the PR review button names a stale pending review when it can't be added to", async () => {
      apiMock.prComments.mockResolvedValue(summary({ pending_comments: 1 }))
      apiMock.prWriteCheck.mockResolvedValue({
        review: { postable: false, reason: "newer than your pending review", stale_pending_commit: "abc1234" },
        single: { postable: true },
      })
      wrap(<NewCommentCard path="/w-pr8" target={target} view={view} onDone={() => {}} />)
      await userEvent.type(screen.getByRole("textbox"), "x")
      const b = await screen.findByRole("button", { name: "Add to PR review #12" })
      await waitFor(() => expect(apiMock.prWriteCheck).toHaveBeenCalled())
      await userEvent.hover(b)
      expect(
        await screen.findByText(
          "newer than your pending review — Your pending review on PR #12 is on an older commit (abc1234). Comments on newer code can't be added to it; submit it to start a new one.",
        ),
      ).toBeInTheDocument()
    })

    it("hides the GitHub buttons when the watcher is off and the PR can't be told", async () => {
      apiMock.prComments.mockResolvedValue(offSummary())
      wrap(<NewCommentCard path="/w-pr5b" target={target} view={view} onDone={() => {}} />)
      await userEvent.type(screen.getByRole("textbox"), "x")
      expect(await screen.findByRole("button", { name: /local/i })).toBeInTheDocument()
      await waitFor(() => expect(apiMock.prComments).toHaveBeenCalled())
      expect(screen.queryByRole("button", { name: /PR/ })).toBeNull()
    })

    it("disables the GitHub buttons when the watcher is off", async () => {
      apiMock.prComments.mockResolvedValue(offSummary(summary().pr))
      wrap(<NewCommentCard path="/w-pr5" target={target} view={view} onDone={() => {}} />)
      await userEvent.type(screen.getByRole("textbox"), "x")
      const b = await screen.findByRole("button", { name: "Comment on PR #12" })
      expect(b).toHaveAttribute("aria-disabled", "true")
      await userEvent.hover(b)
      expect(await screen.findByText("The GitHub watcher is off")).toBeInTheDocument()
      expect(apiMock.prWriteCheck).not.toHaveBeenCalled()
    })

    it("the PR review button adds the comment to the review, then closes", async () => {
      apiMock.prComments.mockResolvedValue(summary())
      apiMock.prWriteComment.mockResolvedValue({ comment_id: 99 })
      const onDone = vi.fn()
      wrap(<NewCommentCard path="/w-pr6" target={target} view={view} onDone={onDone} />)
      await userEvent.type(screen.getByRole("textbox"), "nice")
      await userEvent.click(await enabled("Start a PR review on #12"))
      await waitFor(() => expect(onDone).toHaveBeenCalled())
      expect(apiMock.prWriteComment).toHaveBeenCalledWith({
        path: "/w-pr6",
        mode: "review",
        file: "src/a.ts",
        side: "new",
        start_line: 4,
        end_line: 6,
        body: "nice",
        old_rev: "o1",
        new_rev: "n1",
      })
      expect(apiMock.createReviewComment).not.toHaveBeenCalled()
    })

    it("Comment on PR posts a single comment; a refusal shows its reason and keeps the text", async () => {
      apiMock.prComments.mockResolvedValue(summary())
      apiMock.prWriteComment.mockRejectedValue(new HttpError("conflict", 409, { reason: "out of date" }))
      const onDone = vi.fn()
      wrap(<NewCommentCard path="/w-pr7" target={target} view={view} onDone={onDone} />)
      await userEvent.type(screen.getByRole("textbox"), "nice")
      await userEvent.click(await enabled("Comment on PR #12"))
      expect(await screen.findByText("out of date")).toBeInTheDocument()
      expect(apiMock.prWriteComment).toHaveBeenCalledWith(expect.objectContaining({ mode: "single" }))
      expect(screen.getByRole("textbox")).toHaveValue("nice")
      expect(onDone).not.toHaveBeenCalled()
    })
  })
})

const LOCAL_TIP =
  "Save this comment only in worktree, as part of your local review. Nothing is posted to GitHub. You can copy your local review for an agent, or include it when you submit a PR review."
