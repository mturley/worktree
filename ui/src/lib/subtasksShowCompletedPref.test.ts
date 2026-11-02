import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readSubtasksShowCompleted, writeSubtasksShowCompleted } from "./subtasksShowCompletedPref"

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("subtasksShowCompletedPref", () => {
  it("defaults to on and round-trips", () => {
    expect(readSubtasksShowCompleted()).toBe(true)
    expect(writeSubtasksShowCompleted(false)).toBe(true)
    expect(readSubtasksShowCompleted()).toBe(false)
    writeSubtasksShowCompleted(true)
    expect(readSubtasksShowCompleted()).toBe(true)
  })

  it("stays on when storage is blocked, rather than throwing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked") })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked") })
    expect(readSubtasksShowCompleted()).toBe(true)
    expect(writeSubtasksShowCompleted(false)).toBe(false)
  })
})
