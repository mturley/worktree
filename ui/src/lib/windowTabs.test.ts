import { describe, expect, it } from "vitest"
import { windowTabs } from "./windowTabs"

const tabs = (n: number, selected: number | null) =>
  Array.from({ length: n }, (_, id) => ({ id, selected: id === selected }))
const ids = (xs: { id: number }[]) => xs.map((x) => x.id)
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)

describe("windowTabs", () => {
  it("shows every tab up to the limit", () => {
    const w = windowTabs(tabs(10, 9), 10)
    expect(ids(w.shown)).toEqual(range(0, 10))
    expect(w.before).toEqual([])
    expect(w.after).toEqual([])
  })

  it("starts at the top while the selected tab is within the first N", () => {
    const w = windowTabs(tabs(12, 9), 10)
    expect(ids(w.shown)).toEqual(range(0, 10))
    expect(ids(w.after)).toEqual([10, 11])
    expect(w.before).toEqual([])
  })

  it("starts at the top when no tab is selected", () => {
    const w = windowTabs(tabs(12, null), 10)
    expect(ids(w.shown)).toEqual(range(0, 10))
  })

  it("centres on a selected tab past the first N", () => {
    const w = windowTabs(tabs(30, 14), 10)
    expect(ids(w.before)).toEqual(range(0, 10))
    expect(ids(w.shown)).toEqual(range(10, 20))
    expect(ids(w.after)).toEqual(range(20, 30))
  })

  it("clamps to the end for a selected tab near the end", () => {
    const w = windowTabs(tabs(22, 21), 10)
    expect(ids(w.before)).toEqual(range(0, 12))
    expect(ids(w.shown)).toEqual(range(12, 22))
    expect(w.after).toEqual([])
  })
})
