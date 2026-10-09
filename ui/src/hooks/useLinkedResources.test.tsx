import { afterEach, describe, it, expect, vi } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../api/client"
import type { LinkedResourcesDTO } from "../api/types"
import { useLinkedResources } from "./useLinkedResources"

const dto = (count: number): LinkedResourcesDTO => ({ fetched_at: "2026-10-09T12:00:00Z", count, sections: [] })
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
)

afterEach(() => vi.restoreAllMocks())

describe("useLinkedResources", () => {
  it("fetches without link resolution, then keeps showing data while resolving", async () => {
    const spy = vi.spyOn(api, "linkedResources")
      .mockResolvedValueOnce(dto(2))
      .mockImplementationOnce(() => new Promise(() => {})) // resolved fetch never lands
    const { result, rerender } = renderHook(({ r }) => useLinkedResources("pr", "o/r#1", r), {
      wrapper, initialProps: { r: false },
    })
    await waitFor(() => expect(result.current.data?.count).toBe(2))
    expect(spy).toHaveBeenCalledWith("pr", "o/r#1", { resolveLinks: false })
    rerender({ r: true })
    expect(spy).toHaveBeenLastCalledWith("pr", "o/r#1", { resolveLinks: true })
    expect(result.current.data?.count).toBe(2) // placeholder, not a spinner
  })

  it("refresh bypasses the server cache", async () => {
    const spy = vi.spyOn(api, "linkedResources").mockResolvedValueOnce(dto(1)).mockResolvedValueOnce(dto(5))
    const { result } = renderHook(() => useLinkedResources("jira", "PROJ-1", true), { wrapper })
    await waitFor(() => expect(result.current.data?.count).toBe(1))
    await act(() => result.current.refresh())
    expect(spy).toHaveBeenLastCalledWith("jira", "PROJ-1", { resolveLinks: true, refresh: true })
    await waitFor(() => expect(result.current.data?.count).toBe(5))
  })
})
