import { beforeEach, describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useDiffView } from "./useDiffView"

beforeEach(() => {
  window.history.replaceState({}, "", "/worktree/x?q=oauth&resource=pr:o%2Fr%231")
})

describe("useDiffView", () => {
  it("is closed by default", () => {
    const { result } = renderHook(() => useDiffView())
    expect(result.current.open).toBe(false)
    expect(result.current.file).toBeNull()
  })

  it("enter(file) adds ?diff&file= and keeps other params", () => {
    const { result } = renderHook(() => useDiffView())
    act(() => result.current.enter("a b.go"))
    expect(window.location.search).toBe("?q=oauth&resource=pr%3Ao%2Fr%231&diff&file=a%20b.go")
    expect(result.current.open).toBe(true)
    expect(result.current.file).toBe("a b.go")
  })

  it("enter() opens without a file", () => {
    const { result } = renderHook(() => useDiffView())
    act(() => result.current.enter())
    expect(window.location.search).toContain("diff")
    expect(new URLSearchParams(window.location.search).has("file")).toBe(false)
    expect(result.current.open).toBe(true)
  })

  it("leave() removes diff and file but keeps the rest", () => {
    const { result } = renderHook(() => useDiffView())
    act(() => result.current.enter("a b.go"))
    act(() => result.current.leave())
    const params = new URLSearchParams(window.location.search)
    expect(params.has("diff")).toBe(false)
    expect(params.has("file")).toBe(false)
    expect(params.get("q")).toBe("oauth")
    expect(result.current.open).toBe(false)
  })

  it("leave(set) sets params in the same navigation, so nothing overwrites them", () => {
    const { result } = renderHook(() => useDiffView())
    act(() => result.current.enter())
    act(() => result.current.leave({ q: "new query" }))
    const params = new URLSearchParams(window.location.search)
    expect(params.has("diff")).toBe(false)
    expect(params.get("q")).toBe("new query")
    expect(params.get("resource")).toBe("pr:o/r#1")
  })

  it("reads &prcomment and drops it with a replace, keeping the view open", () => {
    window.history.replaceState({}, "", "/worktree/x?q=oauth&diff&prcomment=11")
    const before = window.history.length
    const { result } = renderHook(() => useDiffView())
    expect(result.current.prComment).toBe(11)
    act(() => result.current.dropPRComment())
    expect(window.location.search).toBe("?q=oauth&diff")
    expect(window.history.length).toBe(before)
    expect(result.current.open).toBe(true)
    expect(result.current.prComment).toBeNull()
  })

  it("ignores a malformed &prcomment", () => {
    window.history.replaceState({}, "", "/worktree/x?diff&prcomment=abc")
    const { result } = renderHook(() => useDiffView())
    expect(result.current.prComment).toBeNull()
  })
})
