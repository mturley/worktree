import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReviewCommentItem } from "../../api/types"

const apiMock = vi.hoisted(() => ({
  clearReviewComments: vi.fn(),
  updateReviewComment: vi.fn(),
  deleteReviewComment: vi.fn(),
}))
vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return { ...actual, api: { ...actual.api, ...apiMock } }
})

import { HttpError } from "../../api/client"
import { useDeletedDrafts } from "../../hooks/useReviewComments"
import { ReviewSidebar } from "./ReviewSidebar"

const item = (id: number, over: Partial<ReviewCommentItem> = {}): ReviewCommentItem => ({
  id,
  source: "draft",
  editable: true,
  file: `f${id}.ts`,
  side: "new",
  start_line: id,
  end_line: id,
  rev: "abc",
  base: "merge-base",
  base_ref: "main",
  snippet: [],
  body: `body ${id}`,
  version: 1,
  created_at: "",
  updated_at: "",
  prompt: { status: "current", start_line: id, end_line: id },
  view: { status: "shown", start_line: id, end_line: id },
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

const sidebar = (over: Partial<React.ComponentProps<typeof ReviewSidebar>> = {}) => (
  <ReviewSidebar path="/w" comments={[item(2), item(1)]} prompt="the prompt" onJump={() => {}} escHint={false} {...over} />
)

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe("ReviewSidebar", () => {
  it("lists comments in the given order", () => {
    wrap(sidebar())
    const bodies = screen.getAllByText(/^body \d$/).map((e) => e.textContent)
    expect(bodies).toEqual(["body 2", "body 1"])
  })

  it("send opens the modal with the prompt and a copy button", async () => {
    wrap(sidebar())
    await userEvent.click(screen.getByRole("button", { name: "Send comments to agent" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("textbox")).toHaveValue("the prompt")
    expect(within(dialog).getByRole("textbox")).toHaveAttribute("readonly")
    expect(within(dialog).getByRole("button", { name: "Copy to clipboard" })).toBeInTheDocument()
  })

  it("clear asks for confirmation then clears", async () => {
    apiMock.clearReviewComments.mockResolvedValue(undefined)
    wrap(sidebar())
    await userEvent.click(screen.getByRole("button", { name: "Clear comments" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Delete all 2 review comments? This can't be undone.")).toBeInTheDocument()
    expect(apiMock.clearReviewComments).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole("button", { name: "Clear comments" }))
    await waitFor(() => expect(apiMock.clearReviewComments).toHaveBeenCalledWith("/w"))
  })

  it("close shows the Esc hint only when escHint", async () => {
    const onClose = vi.fn()
    const { unmount } = wrap(sidebar({ onClose, escHint: true }))
    expect(screen.getByText("Esc")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Close review comments" }))
    expect(onClose).toHaveBeenCalled()
    unmount()
    wrap(sidebar({ onClose, escHint: false }))
    expect(screen.getByRole("button", { name: "Close review comments" })).toBeInTheDocument()
    expect(screen.queryByText("Esc")).not.toBeInTheDocument()
  })

  it("disables jump for a comment outside the changes", () => {
    wrap(sidebar({ comments: [item(1, { view: { status: "outside_changes" } })] }))
    expect(screen.getByRole("button", { name: "Jump to comment" })).toBeDisabled()
  })

  it("lists a deleted-elsewhere draft after the live comments until dismissed", async () => {
    const { result } = renderHook(() => useDeletedDrafts("/w"))
    act(() => result.current.add({ comment: item(9), text: "typed text" }))
    wrap(sidebar({ comments: [item(1)] }))
    expect(screen.getByText("Deleted elsewhere")).toBeInTheDocument()
    const texts = screen.getAllByText(/^(body 1|typed text)$/).map((e) => e.textContent)
    expect(texts).toEqual(["body 1", "typed text"])
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByText("Deleted elsewhere")).not.toBeInTheDocument()
  })

  it("its cards record the list's view with a tombstone", async () => {
    apiMock.updateReviewComment.mockRejectedValueOnce(new HttpError("gone", 404))
    const drafts = renderHook(() => useDeletedDrafts("/w")).result
    wrap(sidebar({ comments: [item(1)], viewKey: "o..n" }))
    await userEvent.click(screen.getByRole("button", { name: "Edit comment" }))
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(drafts.current.drafts).toHaveLength(1))
    expect(drafts.current.drafts[0].view).toBe("o..n")
    act(() => drafts.current.dismiss(1))
  })
})
