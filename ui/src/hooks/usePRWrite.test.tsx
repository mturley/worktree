import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const apiMock = vi.hoisted(() => ({
  prWriteCheck: vi.fn(),
  prWriteComment: vi.fn(),
  prWriteReply: vi.fn(),
  prSubmit: vi.fn(),
}))
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { ...actual, api: { ...actual.api, ...apiMock } }
})

import { usePRWriteCheck, usePRWriteMutations } from "./usePRWrite"

const target = { file: "a.ts", side: "new", start_line: 1, end_line: 2, old_rev: "o", new_rev: "n" }

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const spy = vi.spyOn(client, "invalidateQueries")
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { wrapper, spy }
}

afterEach(() => vi.clearAllMocks())

describe("usePRWriteCheck", () => {
  it("fetches with a target and a PR", async () => {
    apiMock.prWriteCheck.mockResolvedValue({ review: { postable: true }, single: { postable: false, reason: "out of date" } })
    const { wrapper } = setup()
    const { result } = renderHook(() => usePRWriteCheck("/w", target, true), { wrapper })
    await waitFor(() => expect(result.current.data?.single.reason).toBe("out of date"))
    expect(apiMock.prWriteCheck).toHaveBeenCalledWith("/w", target)
  })
  it("stays off without a target or without a PR", () => {
    const { wrapper } = setup()
    renderHook(() => usePRWriteCheck("/w", undefined, true), { wrapper })
    renderHook(() => usePRWriteCheck("/w", target, false), { wrapper })
    expect(apiMock.prWriteCheck).not.toHaveBeenCalled()
  })
})

describe("usePRWriteMutations", () => {
  it("invalidates comments, threads and review comments on success", async () => {
    apiMock.prWriteComment.mockResolvedValue({ comment_id: 1 })
    const { wrapper, spy } = setup()
    const { result } = renderHook(() => usePRWriteMutations("/w"), { wrapper })
    await act(async () => {
      await result.current.comment.mutateAsync({ ...target, mode: "review", body: "hi" })
    })
    expect(apiMock.prWriteComment).toHaveBeenCalledWith({ ...target, mode: "review", body: "hi", path: "/w" })
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey)
    expect(keys).toContainEqual(["pr-comments", "/w"])
    expect(keys).toContainEqual(["pr-threads", "/w"])
    expect(keys).toContainEqual(["review-comments", "/w"])
  })
  it("reply and submit pass the path", async () => {
    apiMock.prWriteReply.mockResolvedValue({ comment_id: 2 })
    apiMock.prSubmit.mockResolvedValue({ posted_local_ids: [], kept_local_ids: [] })
    const { wrapper } = setup()
    const { result } = renderHook(() => usePRWriteMutations("/w"), { wrapper })
    await act(async () => {
      await result.current.reply.mutateAsync({ thread_id: "t", in_reply_to: 5, mode: "single", body: "b" })
      await result.current.submit.mutateAsync({ head: "h", event: "COMMENT", body: "", include_local: true })
    })
    expect(apiMock.prWriteReply).toHaveBeenCalledWith({ thread_id: "t", in_reply_to: 5, mode: "single", body: "b", path: "/w" })
    expect(apiMock.prSubmit).toHaveBeenCalledWith({ head: "h", event: "COMMENT", body: "", include_local: true, path: "/w" })
  })
})
