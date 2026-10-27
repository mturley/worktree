import { describe, expect, it, vi } from "vitest"
import { type CrossHoverItem, createCrossHoverStore, crossLit, crossResourceRef } from "./crossHover"

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

describe("crossLit with tasks", () => {
  const task = (id: string, resources: string[], paths: string[]): CrossHoverItem =>
    ({ kind: "task", id, resources, paths })
  const t1 = task("1", [crossResourceRef("pr", "1")], ["/wt/a"])

  it("pairs a task with the resources it links, both ways", () => {
    expect(crossLit(t1, res("1", []))).toBe(true)
    expect(crossLit(res("1", []), t1)).toBe(true)
    expect(crossLit(t1, res("2", []))).toBe(false)
    expect(crossLit(res("2", ["/wt/a"]), t1)).toBe(false)
  })

  it("pairs a task with its worktrees, both ways", () => {
    expect(crossLit(t1, wtA)).toBe(true)
    expect(crossLit(wtA, t1)).toBe(true)
    expect(crossLit(wtB, t1)).toBe(false)
  })

  it("pairs a task with its own task events, not its resources' events", () => {
    const own: CrossHoverItem = { kind: "event", type: "task", id: "1", paths: [] }
    expect(crossLit(t1, own)).toBe(true)
    expect(crossLit(own, t1)).toBe(true)
    expect(crossLit(t1, { kind: "event", type: "task", id: "2", paths: [] })).toBe(false)
    expect(crossLit(t1, evt("1", []))).toBe(false)
  })

  it("never pairs two tasks", () => {
    expect(crossLit(t1, task("2", [crossResourceRef("pr", "1")], ["/wt/a"]))).toBe(false)
  })
})
