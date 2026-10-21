import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useWorktreeDetail } from "./useWorktreeDetail"

vi.mock("../api/client", async (orig) => ({
  ...(await orig<typeof import("../api/client")>()),
  api: {
    pollWorktree: vi.fn(() => Promise.resolve({ polled: false })),
    worktreeResources: vi.fn(() => Promise.resolve([])),
    worktreeTimeline: vi.fn(() => Promise.resolve({ events: [], next_cursor: "" })),
  },
}))

afterEach(cleanup)

describe("useWorktreeDetail", () => {
  it("refreshResources also invalidates tasks (follow/unfollow/regroup change task membership)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    const { result } = renderHook(() => useWorktreeDetail("/w"), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    })
    await act(async () => { await result.current.refreshResources() })
    expect(invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))).toContain(JSON.stringify(["tasks"]))
  })
})
