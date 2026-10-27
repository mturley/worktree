import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useShowPRComments } from "./usePRComments"

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("useShowPRComments", () => {
  it("defaults to true and persists false", () => {
    const a = renderHook(() => useShowPRComments())
    expect(a.result.current[0]).toBe(true)
    act(() => a.result.current[1](false))
    expect(a.result.current[0]).toBe(false)
    const b = renderHook(() => useShowPRComments())
    expect(b.result.current[0]).toBe(false)
  })
  it("still toggles when storage getItem throws", () => {
    // The blocked-storage fallback is module state; start it from the default.
    const reset = renderHook(() => useShowPRComments())
    act(() => reset.result.current[1](true))
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    const a = renderHook(() => useShowPRComments())
    expect(a.result.current[0]).toBe(true)
    act(() => a.result.current[1](false))
    expect(a.result.current[0]).toBe(false)
    act(() => a.result.current[1](true))
    expect(a.result.current[0]).toBe(true)
  })
})
