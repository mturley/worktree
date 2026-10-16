import { describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../api/client"
import { useGlobalTimeline } from "./useTimeline"

describe("useGlobalTimeline q", () => {
  it("passes q to the API and keys the cache by it", async () => {
    const spy = vi.spyOn(api, "globalTimeline").mockResolvedValue({ events: [], next_cursor: "" })
    const qc = new QueryClient()
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    renderHook(() => useGlobalTimeline(false, [], false, [], "oauth"), { wrapper })
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.calls[0][6]).toBe("oauth")
    // No query keeps the pre-search key, so clearing a search is a cache hit.
    expect(qc.getQueryCache().find({ queryKey: ["timeline", "global", false, "", false, "", "oauth"] })).toBeTruthy()
    renderHook(() => useGlobalTimeline(false, [], false, []), { wrapper })
    expect(qc.getQueryCache().find({ queryKey: ["timeline", "global", false, "", false, ""], exact: true })).toBeTruthy()
  })
})
