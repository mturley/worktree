import { afterEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_TASK_LIST_PREFS,
  TASK_LIST_KEY,
  parseTaskListPrefs,
  readTaskListPrefs,
  writeTaskListPrefs,
} from "./taskListPrefs"

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe("taskListPrefs", () => {
  it("round-trips", () => {
    const p = { sort: "priority", showCompleted: true, includeArchived: true, collapsed: true } as const
    expect(writeTaskListPrefs(p)).toBe(true)
    expect(readTaskListPrefs()).toEqual(p)
  })

  it("falls back to the defaults when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(readTaskListPrefs()).toEqual({
      sort: "custom", showCompleted: false, includeArchived: false, collapsed: false,
    })
    expect(writeTaskListPrefs(DEFAULT_TASK_LIST_PREFS)).toBe(false)
  })

  it("merges stored values over the defaults and drops invalid fields", () => {
    window.localStorage.setItem(TASK_LIST_KEY, JSON.stringify({ sort: "bogus", priority: "low", collapsed: "yes", showCompleted: true }))
    expect(readTaskListPrefs()).toEqual({ ...DEFAULT_TASK_LIST_PREFS, showCompleted: true })
  })

  it("ignores unparseable JSON", () => {
    window.localStorage.setItem(TASK_LIST_KEY, "{nope")
    expect(readTaskListPrefs()).toEqual(DEFAULT_TASK_LIST_PREFS)
    window.localStorage.setItem(TASK_LIST_KEY, "[1]")
    expect(readTaskListPrefs()).toEqual(DEFAULT_TASK_LIST_PREFS)
  })

  it("reads collapsed, and only as a boolean", () => {
    expect(parseTaskListPrefs('{"collapsed":true}').collapsed).toBe(true)
    expect(parseTaskListPrefs('{"collapsed":"yes"}').collapsed).toBe(false)
  })

  it("ignores an old pinned key", () => {
    const p = parseTaskListPrefs('{"pinned":true}')
    expect(p).toEqual(DEFAULT_TASK_LIST_PREFS)
    expect(p).not.toHaveProperty("pinned")
    expect(p.collapsed).toBe(false)
  })
})
