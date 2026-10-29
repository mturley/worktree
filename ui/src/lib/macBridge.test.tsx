import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { hasMacBridge, postToMac } from "./macBridge"
import { useMacUnreadBridge } from "../hooks/useMacUnreadBridge"

afterEach(() => vi.unstubAllGlobals())

describe("postToMac", () => {
  it("does not throw without a bridge", () => {
    expect(hasMacBridge()).toBe(false)
    expect(() => postToMac({ type: "ready" })).not.toThrow()
  })

  it("posts to the worktree handler", () => {
    const post = vi.fn()
    vi.stubGlobal("webkit", { messageHandlers: { worktree: { postMessage: post } } })
    expect(hasMacBridge()).toBe(true)
    postToMac({ type: "ready" })
    expect(post).toHaveBeenCalledWith({ type: "ready" })
  })
})

describe("useMacUnreadBridge", () => {
  it("posts the unread state on mount and on change", async () => {
    const post = vi.fn()
    vi.stubGlobal("webkit", { messageHandlers: { worktree: { postMessage: post } } })
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    qc.setQueryData(["worktrees"], [{ has_unread: true, unread_count: 2 }])
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    renderHook(() => useMacUnreadBridge(), { wrapper })
    expect(post).toHaveBeenLastCalledWith({ type: "unread", unread: true, count: 2 })
    act(() => { qc.setQueryData(["worktrees"], [{ has_unread: false, unread_count: 0 }]) })
    // react-query notifies observers on a timer.
    await waitFor(() => expect(post).toHaveBeenLastCalledWith({ type: "unread", unread: false, count: 0 }))
  })

  it("posts nothing until the worktree list has loaded", async () => {
    const post = vi.fn()
    vi.stubGlobal("webkit", { messageHandlers: { worktree: { postMessage: post } } })
    // No cached data and a fetch that never answers: the list stays unknown.
    vi.stubGlobal("fetch", () => new Promise(() => {}))
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    renderHook(() => useMacUnreadBridge(), { wrapper })
    expect(post).not.toHaveBeenCalled()
    act(() => { qc.setQueryData(["worktrees"], []) })
    await waitFor(() => expect(post).toHaveBeenLastCalledWith({ type: "unread", unread: false, count: 0 }))
  })
})
