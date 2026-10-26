import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const apiMock = vi.hoisted(() => ({
  reviewComments: vi.fn(),
  updateReviewComment: vi.fn(),
}))
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return {
    ...actual,
    api: { ...actual.api, reviewComments: apiMock.reviewComments, updateReviewComment: apiMock.updateReviewComment },
  }
})

import { HttpError } from "../api/client"
import {
  conflictComment,
  editDraftKey,
  NEW_DRAFT_KEY,
  useDeletedDrafts,
  useEditingCommentIds,
  useEditorDraft,
  useReviewCommentMutations,
  useReviewComments,
} from "./useReviewComments"

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <MantineProvider>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </MantineProvider>
  )
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe("useReviewComments", () => {
  it("passes the view revs", async () => {
    apiMock.reviewComments.mockResolvedValue({ comments: [] })
    const view = { oldRev: "o1", newRev: "n1" }
    const { result } = renderHook(() => useReviewComments("/w", view), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(apiMock.reviewComments).toHaveBeenCalledWith("/w", view)
  })

  it("refetches on a 5s interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiMock.reviewComments.mockResolvedValue({ comments: [] })
    const { result } = renderHook(() => useReviewComments("/w", undefined), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const n = apiMock.reviewComments.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(5100) })
    expect(apiMock.reviewComments.mock.calls.length).toBeGreaterThan(n)
  })

  it("a successful update invalidates the list", async () => {
    apiMock.reviewComments.mockResolvedValue({ comments: [] })
    apiMock.updateReviewComment.mockResolvedValue({ id: 1 })
    const { result } = renderHook(
      () => ({ list: useReviewComments("/w", undefined), m: useReviewCommentMutations("/w") }),
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true))
    const n = apiMock.reviewComments.mock.calls.length
    await act(async () => { await result.current.m.update.mutateAsync({ id: 1, version: 1, body: "x" }) })
    expect(apiMock.updateReviewComment).toHaveBeenCalledWith({ path: "/w", id: 1, version: 1, body: "x" })
    await waitFor(() => expect(apiMock.reviewComments.mock.calls.length).toBeGreaterThan(n))
  })
})

describe("conflictComment", () => {
  const comment = { id: 1, version: 3, body: "theirs" }
  it("returns the comment from a 409", () => {
    expect(conflictComment(new HttpError("stale", 409, { error: "stale", comment }))).toEqual(comment)
  })
  it("is undefined for a 404 or a malformed body", () => {
    expect(conflictComment(new HttpError("gone", 404, { error: "gone" }))).toBeUndefined()
    expect(conflictComment(new HttpError("stale", 409, { comment: "nope" }))).toBeUndefined()
    expect(conflictComment(new HttpError("stale", 409))).toBeUndefined()
    expect(conflictComment(new Error("x"))).toBeUndefined()
  })
})

describe("useDeletedDrafts", () => {
  const draft = (id: number, text: string) =>
    ({ comment: { id } as import("../api/types").ReviewCommentItem, text })

  it("adds, replaces, dismisses and scopes per path", () => {
    const a = renderHook(() => useDeletedDrafts("/da"))
    const b = renderHook(() => useDeletedDrafts("/db"))
    act(() => a.result.current.add(draft(1, "one")))
    act(() => a.result.current.add(draft(2, "two")))
    act(() => a.result.current.add(draft(1, "uno")))
    expect(a.result.current.drafts.map((d) => [d.comment.id, d.text])).toEqual([[2, "two"], [1, "uno"]])
    expect(b.result.current.drafts).toEqual([])
    act(() => a.result.current.dismiss(2))
    act(() => a.result.current.dismiss(1))
    expect(a.result.current.drafts).toEqual([])
  })
})

describe("editor drafts", () => {
  it("sets, updates, clears and scopes per path and key", () => {
    const a = renderHook(() => useEditorDraft("/ea", editDraftKey("inline", 3)))
    const other = renderHook(() => useEditorDraft("/eb", editDraftKey("inline", 3)))
    act(() => a.result.current[1]({ text: "x", baseVersion: 2 }))
    act(() => a.result.current[1]((d) => d && { ...d, text: "xy" }))
    expect(a.result.current[0]).toEqual({ text: "xy", baseVersion: 2 })
    expect(other.result.current[0]).toBeUndefined()
    act(() => a.result.current[1](undefined))
    expect(a.result.current[0]).toBeUndefined()
  })

  it("lists the comments being edited, in either variant, and not a new comment", () => {
    const ids = renderHook(() => useEditingCommentIds("/ec", ["inline", "sidebar"]))
    const inlineIds = renderHook(() => useEditingCommentIds("/ec", ["inline"]))
    const inline = renderHook(() => useEditorDraft("/ec", editDraftKey("inline", 4)))
    const sidebar = renderHook(() => useEditorDraft("/ec", editDraftKey("sidebar", 9)))
    const added = renderHook(() => useEditorDraft("/ec", NEW_DRAFT_KEY))
    act(() => added.result.current[1]({ text: "new", target: "t" }))
    expect(ids.result.current).toEqual([])
    act(() => inline.result.current[1]({ text: "a", baseVersion: 1 }))
    act(() => sidebar.result.current[1]({ text: "b", baseVersion: 1 }))
    const before = ids.result.current
    expect(before).toEqual([4, 9])
    // Only the variants asked for.
    expect(inlineIds.result.current).toEqual([4])
    // Typing changes nothing here.
    act(() => inline.result.current[1]((d) => d && { ...d, text: "ab" }))
    expect(ids.result.current).toBe(before)
    act(() => {
      inline.result.current[1](undefined)
      sidebar.result.current[1](undefined)
      added.result.current[1](undefined)
    })
    expect(ids.result.current).toEqual([])
  })
})
