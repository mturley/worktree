import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useSearchQuery } from "./useSearchQuery"

beforeEach(() => {
  vi.useFakeTimers()
  window.history.replaceState({}, "", "/worktree/x?resource=pr:o%2Fr%231")
})
afterEach(() => vi.useRealTimers())

describe("useSearchQuery", () => {
  it("reads and writes ?q= with replace, keeping other params", () => {
    const len = window.history.length
    const { result } = renderHook(() => useSearchQuery())
    expect(result.current.q).toBe("")
    act(() => result.current.setQ("OAuth proxy"))
    expect(result.current.q).toBe("OAuth proxy")
    expect(result.current.terms).toEqual(["oauth", "proxy"])
    const params = new URLSearchParams(window.location.search)
    expect(params.get("q")).toBe("OAuth proxy")
    expect(params.get("resource")).toBe("pr:o/r#1")
    expect(window.history.length).toBe(len)
  })
  it("removes the param when cleared", () => {
    const { result } = renderHook(() => useSearchQuery())
    act(() => result.current.setQ("x"))
    act(() => result.current.setQ(""))
    expect(new URLSearchParams(window.location.search).has("q")).toBe(false)
  })
  it("debounces the server value by 250ms and trims it", () => {
    const { result } = renderHook(() => useSearchQuery())
    act(() => result.current.setQ(" oauth "))
    expect(result.current.debouncedQ).toBe("")
    act(() => { vi.advanceTimersByTime(250) })
    expect(result.current.debouncedQ).toBe("oauth")
  })
})
