import { describe, expect, it, vi } from "vitest"
import { type CrossHoverItem, createCrossHoverStore, crossLit } from "./crossHover"

const wtA: CrossHoverItem = { kind: "worktree", path: "/wt/a" }
const wtB: CrossHoverItem = { kind: "worktree", path: "/wt/b" }
const res = (id: string, paths: string[]): CrossHoverItem => ({ kind: "resource", type: "pr", id, paths })
const evt = (id: string, paths: string[]): CrossHoverItem => ({ kind: "event", type: "pr", id, paths })

describe("crossLit", () => {
  it("lights nothing while nothing is hovered", () => {
    expect(crossLit(null, wtA)).toBe(false)
  })

  it("pairs a worktree with the resources and events it follows, both ways", () => {
    expect(crossLit(wtA, res("1", ["/wt/a", "/wt/b"]))).toBe(true)
    expect(crossLit(wtA, evt("1", ["/wt/b"]))).toBe(false)
    expect(crossLit(evt("1", ["/wt/a", "/wt/b"]), wtB)).toBe(true)
    expect(crossLit(res("1", ["/wt/b"]), wtA)).toBe(false)
  })

  it("pairs a resource with its own events, both ways", () => {
    expect(crossLit(res("1", []), evt("1", []))).toBe(true)
    expect(crossLit(evt("1", []), res("1", []))).toBe(true)
    expect(crossLit(evt("2", []), res("1", []))).toBe(false)
  })

  it("never pairs two items of the same kind", () => {
    expect(crossLit(wtA, wtA)).toBe(false)
    expect(crossLit(evt("1", ["/wt/a"]), evt("1", ["/wt/a"]))).toBe(false)
    expect(crossLit(res("1", ["/wt/a"]), res("1", ["/wt/a"]))).toBe(false)
  })
})

describe("createCrossHoverStore", () => {
  it("notifies on change, and not on setting what is already there", () => {
    const store = createCrossHoverStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.set(wtA)
    store.set(wtA)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.get()).toBe(wtA)
    unsubscribe()
    store.set(null)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("ignores hovers while suspended, clearing what was lit", () => {
    const store = createCrossHoverStore()
    store.set(wtA)
    const resumeOne = store.suspend()
    const resumeTwo = store.suspend()
    expect(store.get()).toBeNull()
    store.set(wtB)
    expect(store.get()).toBeNull()
    resumeOne()
    resumeOne()
    store.set(wtB)
    expect(store.get()).toBeNull()
    resumeTwo()
    store.set(wtB)
    expect(store.get()).toBe(wtB)
  })
})
