import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PRCommentsSummary, PRThread, ReviewCommentItem } from "../../api/types"
import { setReviewSidebarTab } from "../../hooks/useReviewSidebar"
import { SHOW_PR_COMMENTS_KEY } from "../../hooks/usePRComments"

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
  <ReviewSidebar path="/w" comments={[item(2), item(1)]} prompt="the prompt" onJump={() => {}} {...over} />
)

beforeEach(() => {
  vi.clearAllMocks()
  setReviewSidebarTab("local")
  window.localStorage.removeItem(SHOW_PR_COMMENTS_KEY)
})
afterEach(cleanup)

describe("ReviewSidebar", () => {
  it("lists comments in the given order", () => {
    wrap(sidebar())
    const bodies = screen.getAllByText(/^body \d$/).map((e) => e.textContent)
    expect(bodies).toEqual(["body 2", "body 1"])
  })

  it("send opens the modal with the prompt and a copy button", async () => {
    wrap(sidebar())
    await userEvent.click(screen.getByRole("button", { name: "Copy comments for agent" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("textbox")).toHaveValue("the prompt")
    expect(within(dialog).getByRole("textbox")).toHaveAttribute("readonly")
    expect(within(dialog).getByRole("button", { name: "Copy to clipboard" })).toBeInTheDocument()
  })

  it("clear asks for confirmation then clears", async () => {
    apiMock.clearReviewComments.mockResolvedValue(undefined)
    wrap(sidebar())
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Delete all 2 review comments? This can't be undone.")).toBeInTheDocument()
    expect(apiMock.clearReviewComments).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole("button", { name: "Clear comments" }))
    await waitFor(() => expect(apiMock.clearReviewComments).toHaveBeenCalledWith("/w"))
  })

  it("disables jump for a comment outside the changes", () => {
    wrap(sidebar({ comments: [item(1, { view: { status: "outside_changes" } })] }))
    expect(screen.getByRole("button", { name: /^Jump to comment/ })).toBeDisabled()
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

const summary = (over: Partial<PRCommentsSummary> = {}): PRCommentsSummary => ({
  state: "ok",
  pr: { id: "o/r#7", number: 7, url: "https://github.com/o/r/pull/7" },
  open_threads: 3,
  unread_comments: 0,
  unread_ids: [],
  pending_comments: 0,
  ...over,
})
const thread = (id: string, over: Partial<PRThread> = {}): PRThread => ({
  id,
  resolved: false,
  outdated: false,
  file: "a.ts",
  side: "new",
  start_line: 1,
  end_line: 1,
  comments: [{ id: 1, author: "bob", body: `text ${id}`, created_at: "2026-01-01T00:00:00Z", url: "https://x", pending: false }],
  ...over,
})
const prSidebar = (s?: PRCommentsSummary, threads?: PRThread[]) =>
  sidebar({
    pr: {
      summary: s,
      threads: s && { state: s.state, branch: s.branch, message: s.message, pr: s.pr, threads: threads ?? [] },
      onJumpThread: () => {},
    },
  })

describe("ReviewSidebar tabs", () => {
  it("shows both tabs with counts and remembers the choice", async () => {
    wrap(prSidebar(summary()))
    expect(screen.getByRole("tab", { name: "Local comments (2)" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: "PR comments (3)" }))
    expect(window.sessionStorage.getItem("worktree.reviewSidebarTab")).toBe("pr")
    expect(screen.queryByRole("button", { name: "Copy comments for agent" })).not.toBeInTheDocument()
  })

  it("keeps the local tab content", () => {
    wrap(prSidebar(summary()))
    expect(screen.getByRole("button", { name: "Copy comments for agent" })).toBeInTheDocument()
  })

  it("explains a branch without a tracked PR", () => {
    setReviewSidebarTab("pr")
    wrap(prSidebar(summary({ state: "no_pr", branch: "x", pr: undefined })))
    expect(screen.getByText("No tracked PR for branch x")).toBeInTheDocument()
  })

  it("explains the watcher being off", () => {
    setReviewSidebarTab("pr")
    wrap(prSidebar(summary({ state: "off" })))
    expect(screen.getByText("The GitHub watcher is off, so PR comments aren't shown")).toBeInTheDocument()
  })

  it("explains a missing token and an error", () => {
    setReviewSidebarTab("pr")
    wrap(prSidebar(summary({ state: "no_token" })))
    expect(screen.getByText("No GitHub token is configured, so PR comments aren't shown")).toBeInTheDocument()
    cleanup()
    wrap(prSidebar(summary({ state: "error", message: "boom" })))
    expect(screen.getByText("Couldn't load PR comments: boom")).toBeInTheDocument()
  })

  it("shows loading while the summary is absent", () => {
    setReviewSidebarTab("pr")
    wrap(prSidebar(undefined))
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("toggles the show switch and lists open threads before resolved", async () => {
    setReviewSidebarTab("pr")
    wrap(prSidebar(summary(), [thread("r", { resolved: true }), thread("o")]))
    const sw = screen.getByRole("switch", { name: "Show in diff view" })
    await userEvent.click(sw)
    expect(window.localStorage.getItem(SHOW_PR_COMMENTS_KEY)).toBe("false")
    expect(screen.getByRole("link", { name: "PR #7" })).toHaveAttribute("href", "https://github.com/o/r/pull/7")
    expect(screen.getByText("text o")).toBeInTheDocument()
    const order = screen.getAllByText(/text o|Resolved/).map((e) => e.textContent)
    expect(order[0]).toBe("text o")
  })
})
