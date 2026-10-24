import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReviewCommentItem } from "../../api/types"

const apiMock = vi.hoisted(() => ({
  createReviewComment: vi.fn(),
  updateReviewComment: vi.fn(),
  deleteReviewComment: vi.fn(),
}))
vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return { ...actual, api: { ...actual.api, ...apiMock } }
})

import { HttpError } from "../../api/client"
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
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MantineProvider>,
  )
}

beforeEach(() => vi.clearAllMocks())
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

  it("delete calls remove without confirmation", async () => {
    apiMock.deleteReviewComment.mockResolvedValue({})
    wrap(<ReviewCommentCard path="/w" comment={item()} variant="inline" />)
    await userEvent.click(screen.getByRole("button", { name: "Delete comment" }))
    await waitFor(() => expect(apiMock.deleteReviewComment).toHaveBeenCalledWith("/w", 7))
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

  it("jump disabled with reason", () => {
    wrap(
      <ReviewCommentCard path="/w" comment={item()} variant="sidebar" onJump={vi.fn()} jumpDisabledReason="Not here" />,
    )
    expect(screen.getByRole("button", { name: "Jump to comment" })).toBeDisabled()
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
    await userEvent.click(screen.getByRole("button", { name: "Comment" }))
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

  it("passes from and to for a commit range", async () => {
    apiMock.createReviewComment.mockResolvedValue({})
    wrap(<NewCommentCard path="/w" target={target} view={{ ...view, range: { from: "a", to: "b" } }} onDone={() => {}} />)
    await userEvent.type(screen.getByRole("textbox"), "x")
    await userEvent.click(screen.getByRole("button", { name: "Comment" }))
    await waitFor(() =>
      expect(apiMock.createReviewComment).toHaveBeenCalledWith(expect.objectContaining({ from: "a", to: "b" })),
    )
  })

  it("keeps text on failure", async () => {
    apiMock.createReviewComment.mockRejectedValue(new Error("boom"))
    const onDone = vi.fn()
    wrap(<NewCommentCard path="/w" target={target} view={view} onDone={onDone} />)
    await userEvent.type(screen.getByRole("textbox"), "nice")
    await userEvent.click(screen.getByRole("button", { name: "Comment" }))
    expect(await screen.findByText("boom")).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toHaveValue("nice")
    expect(onDone).not.toHaveBeenCalled()
  })
})
