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
  it("refreshes terminals every 5s", () => {
    expect(peekQueryOptions("terminal").refetchInterval).toBe(5000)
  })

  it("fetches browser and markdown once per open and keeps nothing", () => {
    for (const type of ["browser", "markdown"]) {
      expect(peekQueryOptions(type)).toEqual({ refetchInterval: false, staleTime: 0, gcTime: 0, retry: false })
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
