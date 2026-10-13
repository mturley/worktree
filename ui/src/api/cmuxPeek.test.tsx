import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { api } from "./client"
import { peekQueryOptions, useCmuxPeek } from "./cmuxPeek"

afterEach(() => vi.restoreAllMocks())

function wrapper() {
  const qc = new QueryClient()
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe("peekQueryOptions", () => {
  it("refreshes terminals every 5s and keeps nothing once closed", () => {
    expect(peekQueryOptions("terminal")).toEqual({ refetchInterval: 5000, staleTime: 0, gcTime: 0, retry: false })
  })

  it("caches browser and markdown peeks: fresh for 60s, kept 10 minutes", () => {
    for (const type of ["browser", "markdown"]) {
      expect(peekQueryOptions(type)).toEqual({ refetchInterval: false, staleTime: 60_000, gcTime: 600_000, retry: false })
    }
  })
})

describe("useCmuxPeek", () => {
  it("fetches the tab's peek by workspace id and surface ref", async () => {
    const spy = vi.spyOn(api, "cmuxPeek").mockResolvedValue({ type: "terminal", text: "hi" })
    const tab = { ref: "surface:4", title: "zsh", type: "terminal", selected: false }
    const { result } = renderHook(() => useCmuxPeek("W", tab), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data?.text).toBe("hi"))
    expect(spy).toHaveBeenCalledWith("W", "surface:4")
  })
})
