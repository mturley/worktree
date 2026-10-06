import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readUnreadOnly, writeUnreadOnly } from "./unreadOnlyPref"

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("unreadOnlyPref", () => {
  it("defaults to off and round-trips", () => {
    expect(readUnreadOnly()).toBe(false)
    expect(writeUnreadOnly(true)).toBe(true)
    expect(readUnreadOnly()).toBe(true)
    writeUnreadOnly(false)
    expect(readUnreadOnly()).toBe(false)
  })

  it("reports blocked storage rather than throwing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked") })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked") })
    expect(readUnreadOnly()).toBeNull()
    expect(writeUnreadOnly(true)).toBe(false)
  })
})
