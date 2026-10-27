import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PRCommentsSummary, PRReviewDialog } from "../../api/types"

const api = vi.hoisted(() => ({ prReviewDialog: vi.fn(), prSubmit: vi.fn() }))
vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return { ...actual, api: { ...actual.api, ...api } }
})

import { SubmitReviewButton } from "./SubmitReviewButton"

const pr = { id: "PR_1", number: 12, url: "https://github.com/o/r/pull/12", title: "Fix the widget" }
const summary = (over: Partial<PRCommentsSummary> = {}): PRCommentsSummary => ({
  state: "ok",
  pr,
  open_threads: 0,
  unread_comments: 0,
  unread_ids: [],
  pending_comments: 1,
  ...over,
})
const dialog: PRReviewDialog = {
  pr,
  viewer_is_author: false,
  head: "1111111111111111111111111111111111111111",
  stale_pending_commit: null,
  pending: { comments: [{ id: 7, file: "src/p.ts", line: 4, body: "pending body" }] },
  local: [],
  blocked_reason: null,
}

beforeEach(() => {
  api.prReviewDialog.mockResolvedValue(dialog)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function wrap(s: PRCommentsSummary | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (x: PRCommentsSummary | undefined) => (
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <SubmitReviewButton path="/w" summary={x} />
      </QueryClientProvider>
    </MantineProvider>
  )
  const r = render(tree(s))
  return { ...r, rerender: (x: PRCommentsSummary | undefined) => r.rerender(tree(x)) }
}

describe("SubmitReviewButton", () => {
  it("is hidden without a PR", () => {
    wrap(summary({ state: "no_pr", pr: undefined }))
    expect(screen.queryByRole("button", { name: /Submit review/ })).toBeNull()
  })

  it("keeps an open dialog, and what was typed, when a poll loses the PR", async () => {
    const r = wrap(summary())
    fireEvent.click(screen.getByRole("button", { name: "Submit review to PR #12…" }))
    const box = await screen.findByRole("textbox", { name: "Review message" })
    fireEvent.change(box, { target: { value: "half written" } })
    r.rerender(summary({ state: "error", pr: undefined, message: "GitHub is down" }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Review message" })).toHaveValue("half written")
  })

  it("goes once the dialog is closed while the PR is gone", async () => {
    const r = wrap(summary())
    fireEvent.click(screen.getByRole("button", { name: "Submit review to PR #12…" }))
    await screen.findByRole("textbox", { name: "Review message" })
    r.rerender(summary({ state: "no_pr", pr: undefined }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("button", { name: /Submit review to PR/ })).toBeNull()
  })
})
