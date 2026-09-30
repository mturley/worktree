import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readCreatedDir, readNameDir, readSortMode, writeCreatedDir, writeNameDir, writeSortMode } from "./worktreeSortPref"

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("worktreeSortPref", () => {
  it("round-trips the mode and direction", () => {
    writeSortMode("unread")
    writeCreatedDir("desc")
    writeNameDir("desc")
    expect(readSortMode()).toBe("unread")
    expect(readCreatedDir()).toBe("desc")
    expect(readNameDir()).toBe("desc")
  })

  it("defaults when nothing is saved", () => {
    expect(readSortMode()).toBeNull()
    expect(readCreatedDir()).toBe("asc")
    expect(readNameDir()).toBe("asc")
  })

  it("ignores garbage left by another build", () => {
    window.localStorage.setItem("worktree.home.sort.mode", "bogus")
    window.localStorage.setItem("worktree.home.sort.createdDir", "sideways")
    expect(readSortMode()).toBeNull()
    expect(readCreatedDir()).toBe("asc")
  })

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked") })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked") })
    expect(readSortMode()).toBeNull()
    expect(readCreatedDir()).toBe("asc")
    expect(() => writeSortMode("name")).not.toThrow()
    expect(() => writeCreatedDir("desc")).not.toThrow()
  })
})
