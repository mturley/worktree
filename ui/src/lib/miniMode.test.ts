import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { isMiniRoute, useMiniLocation } from "./miniMode"

describe("isMiniRoute", () => {
  it("matches only /mini", () => {
    expect(isMiniRoute("/mini")).toBe(true)
    expect(isMiniRoute("/")).toBe(false)
    expect(isMiniRoute("/minified")).toBe(false)
  })
})

describe("useMiniLocation", () => {
  const post = vi.fn()
  beforeEach(() => {
    post.mockClear()
    window.history.replaceState({}, "", "/mini")
    vi.stubGlobal("webkit", { messageHandlers: { worktree: { postMessage: post } } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it("keeps /mini query navigation in place", () => {
    const { result } = renderHook(() => useMiniLocation())
    result.current[1]("/mini?task=t1")
    expect(window.location.search).toContain("task=t1")
    expect(window.location.pathname).toBe("/mini")
    result.current[1]("/mini?home=%2Fx", { replace: true })
    expect(window.location.search).toContain("home=")
    expect(post).not.toHaveBeenCalled()
  })

  it("opens other routes externally and stays on /mini", () => {
    const { result } = renderHook(() => useMiniLocation())
    result.current[1]("/worktree/%2Fx?resource=pr:1")
    expect(window.location.pathname).toBe("/mini")
    expect(post).toHaveBeenCalledWith({
      type: "open",
      url: `${window.location.origin}/worktree/%2Fx?resource=pr:1`,
    })
  })

  it("falls back to window.open without the bridge", () => {
    vi.unstubAllGlobals()
    const open = vi.fn()
    vi.stubGlobal("open", open)
    const { result } = renderHook(() => useMiniLocation())
    result.current[1]("https://example.com/a")
    expect(open).toHaveBeenCalledWith("https://example.com/a", "_blank", "noopener")
  })
})
