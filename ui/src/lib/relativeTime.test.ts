import { describe, it, expect } from "vitest"
import { relativeTime } from "./relativeTime"

describe("relativeTime", () => {
  it("formats a recent timestamp as seconds ago", () => {
    const tenSecAgo = new Date(Date.now() - 10_000).toISOString()
    expect(relativeTime(tenSecAgo)).toMatch(/^\d+s ago$/)
  })
})
