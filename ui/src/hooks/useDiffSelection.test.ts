import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useDiffSelection } from "./useDiffSelection"

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("useDiffSelection", () => {
  it("defaults to merge-base / all", () => {
    const { result } = renderHook(() => useDiffSelection("/w/a", "L1"))
    expect(result.current.base).toBe("merge-base")
    expect(result.current.range).toBe("all")
  })

  it("persists per path", () => {
    const a = renderHook(() => useDiffSelection("/w/a", "L1"))
    act(() => a.result.current.setBase("tracking"))
    act(() => a.result.current.setRange({ from: "x", to: "y" }))
    const again = renderHook(() => useDiffSelection("/w/a", "L1"))
    expect(again.result.current.base).toBe("tracking")
    expect(again.result.current.range).toEqual({ from: "x", to: "y" })
    const other = renderHook(() => useDiffSelection("/w/b", "L1"))
    expect(other.result.current.base).toBe("merge-base")
    expect(other.result.current.range).toBe("all")
  })

  it("resets the range when the list id changes", () => {
    const a = renderHook(() => useDiffSelection("/w/a", "L1"))
    act(() => a.result.current.setRange({ from: "x", to: "y" }))
    const next = renderHook(() => useDiffSelection("/w/a", "L2"))
    expect(next.result.current.range).toBe("all")
  })

  it("keeps the stored range while the list id is still loading", () => {
    const a = renderHook(() => useDiffSelection("/w/a", "L1"))
    act(() => a.result.current.setRange({ from: "x", to: "y" }))
    const loading = renderHook(() => useDiffSelection("/w/a", undefined))
    expect(loading.result.current.range).toEqual({ from: "x", to: "y" })
  })

  it("setBase resets the range", () => {
    const { result } = renderHook(() => useDiffSelection("/w/a", "L1"))
    act(() => result.current.setRange({ from: "x", to: "y" }))
    act(() => result.current.setBase("tracking"))
    expect(result.current.base).toBe("tracking")
    expect(result.current.range).toBe("all")
  })

  it("shares one selection between instances for the same path", () => {
    // The card's badge and the Code tab each hold an instance; a base change
    // in the tab must reach the badge without a remount.
    const card = renderHook(() => useDiffSelection("/w/a", undefined))
    const tab = renderHook(() => useDiffSelection("/w/a", "L1"))
    const other = renderHook(() => useDiffSelection("/w/b", "L1"))
    act(() => tab.result.current.setBase("tracking"))
    expect(card.result.current.base).toBe("tracking")
    expect(other.result.current.base).toBe("merge-base")
    act(() => card.result.current.setBase("merge-base"))
    expect(tab.result.current.base).toBe("merge-base")
    act(() => tab.result.current.setRange({ from: "x", to: "y" }))
    expect(card.result.current.range).toEqual({ from: "x", to: "y" })
  })

  it("survives storage throwing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    const { result } = renderHook(() => useDiffSelection("/w/a", "L1"))
    expect(result.current.base).toBe("merge-base")
    act(() => result.current.setBase("tracking"))
    expect(result.current.base).toBe("tracking")
  })

  it("ignores malformed stored data", () => {
    window.localStorage.setItem("worktree.diffSelection:/w/a", JSON.stringify({ base: "nope", range: 3 }))
    const { result } = renderHook(() => useDiffSelection("/w/a", "L1"))
    expect(result.current.base).toBe("merge-base")
    expect(result.current.range).toBe("all")
  })
})
