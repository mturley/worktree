import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../api/client"
import { useWorktreeSort } from "./useWorktreeSort"

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("useWorktreeSort", () => {
  it("is undecided until cmux answers, then defaults to cmux", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: true, matches: {} })
    const { result } = renderHook(() => useWorktreeSort(), { wrapper })
    expect(result.current.mode).toBeNull()
    await waitFor(() => expect(result.current.mode).toBe("cmux"))
    expect(result.current.cmuxAvailable).toBe(true)
  })

  it("defaults to activity without cmux", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
    const { result } = renderHook(() => useWorktreeSort(), { wrapper })
    await waitFor(() => expect(result.current.mode).toBe("activity"))
    expect(result.current.cmuxAvailable).toBe(false)
  })

  it("uses a saved non-cmux mode immediately", () => {
    window.localStorage.setItem("worktree.home.sort.mode", "name")
    vi.spyOn(api, "cmux").mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useWorktreeSort(), { wrapper })
    expect(result.current.mode).toBe("name")
  })

  it("shows activity for a saved cmux mode without cmux, and keeps what was saved", async () => {
    window.localStorage.setItem("worktree.home.sort.mode", "cmux")
    vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
    const { result } = renderHook(() => useWorktreeSort(), { wrapper })
    await waitFor(() => expect(result.current.mode).toBe("activity"))
    expect(window.localStorage.getItem("worktree.home.sort.mode")).toBe("cmux")
  })

  it("persists changes", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
    const { result } = renderHook(() => useWorktreeSort(), { wrapper })
    act(() => result.current.setMode("created"))
    act(() => result.current.setCreatedDir("desc"))
    expect(result.current.mode).toBe("created")
    expect(result.current.createdDir).toBe("desc")
    expect(window.localStorage.getItem("worktree.home.sort.mode")).toBe("created")
    expect(window.localStorage.getItem("worktree.home.sort.createdDir")).toBe("desc")
  })
})
