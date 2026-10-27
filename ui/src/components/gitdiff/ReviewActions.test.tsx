import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { WorktreeGit } from "../../api/types"
import { ReviewActions } from "./ReviewActions"

const api = vi.hoisted(() => ({
  reviewComments: vi.fn(),
  prComments: vi.fn(),
}))

vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return {
    api: {
      ...actual.api,
      reviewComments: api.reviewComments,
      prComments: api.prComments,
      settings: async () => ({ worktree: { editor: "code" } }),
    },
  }
})

const git: WorktreeGit = {
  on_disk: true, fingerprint: "f", working_fingerprint: "wf", branch: "b",
  main_upstream: "upstream/main", merge_base: "76ef50c1234567890abcdef1234567890abcdef12",
  vs_merge_base: { ahead: 1, behind: 0 },
  tracking: "origin/b", vs_tracking: { ahead: 0, behind: 0 },
  working: { staged: 0, modified: 0, untracked: 0, files: 0 },
  fetch: { last_ok_at: new Date().toISOString(), in_progress: false },
}

beforeEach(() => {
  window.localStorage.clear()
  api.reviewComments.mockResolvedValue({ comments: [] })
  api.prComments.mockResolvedValue({ state: "no_pr", open_threads: 0, unread_comments: 0, unread_ids: [] })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const wrap = (g: WorktreeGit = git) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ReviewActions path="/w/a" git={g} active />
      </QueryClientProvider>
    </MantineProvider>,
  )

describe("ReviewActions", () => {
  it("puts Open in editor before Review changes", async () => {
    wrap()
    const review = await screen.findByRole("button", { name: "Review changes" })
    const editor = screen.getByRole("button", { name: /Open in editor/ })
    expect(editor.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("counts the worktree's pending local comments, in the unread blue", async () => {
    api.reviewComments.mockResolvedValue({ comments: [{ id: 1 }, { id: 2 }, { id: 3 }] })
    wrap()
    const button = await screen.findByRole("button", { name: "Review changes (3 pending local comments)" })
    expect(button).toHaveAttribute("data-variant", "filled")
    // No view: the whole worktree's list.
    expect(api.reviewComments).toHaveBeenCalledWith("/w/a", undefined)
  })

  it("says comment for one", async () => {
    api.reviewComments.mockResolvedValue({ comments: [{ id: 1 }] })
    wrap()
    expect(await screen.findByRole("button", { name: "Review changes (1 pending local comment)" })).toBeInTheDocument()
  })

  it("adds the PR's open threads and unread comments", async () => {
    api.reviewComments.mockResolvedValue({ comments: [{ id: 1 }, { id: 2 }] })
    api.prComments.mockResolvedValue({ state: "ok", open_threads: 5, unread_comments: 3, unread_ids: [] })
    wrap()
    const button = await screen.findByRole("button", {
      name: "Review changes (2 pending local comments, 5 PR comments (3 unread))",
    })
    expect(button).toHaveAttribute("data-variant", "filled")
  })

  it("names a pending PR review, filled", async () => {
    api.prComments.mockResolvedValue({ state: "ok", open_threads: 1, unread_comments: 0, unread_ids: [], pending_comments: 2 })
    wrap()
    const button = await screen.findByRole("button", { name: "Review changes (1 PR comment, pending PR review)" })
    expect(button).toHaveAttribute("data-variant", "filled")
  })

  it("stays light when PR comments are all read", async () => {
    api.prComments.mockResolvedValue({ state: "ok", open_threads: 4, unread_comments: 0, unread_ids: [] })
    wrap()
    const button = await screen.findByRole("button", { name: "Review changes (4 PR comments)" })
    expect(button).toHaveAttribute("data-variant", "light")
  })

  it("is plain with none", async () => {
    wrap()
    const button = await screen.findByRole("button", { name: "Review changes" })
    expect(button).toHaveAttribute("data-variant", "light")
  })

  it("is disabled when there is no diff to review", async () => {
    wrap({ ...git, main_upstream: "", merge_base: "" })
    expect(await screen.findByRole("button", { name: "Review changes" })).toBeDisabled()
  })
})
