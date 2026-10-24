import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { REVIEW_SIDEBAR_KEY, useReviewSidebar } from "./useReviewSidebar"

afterEach(() => {
  vi.restoreAllMocks()
  window.sessionStorage.clear()
})

describe("useReviewSidebar", () => {
  it("defaults to false", () => {
    const { result } = renderHook(() => useReviewSidebar())
    expect(result.current[0]).toBe(false)
  })

  it("persists to sessionStorage", () => {
    const { result } = renderHook(() => useReviewSidebar())
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    expect(window.sessionStorage.getItem(REVIEW_SIDEBAR_KEY)).toBe("true")
    act(() => result.current[1](false))
    expect(result.current[0]).toBe(false)
  })

  it("falls back to memory when sessionStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked") })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked") })
    const { result } = renderHook(() => useReviewSidebar())
    expect(result.current[0]).toBe(false)
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    act(() => result.current[1](false))
  })
})
