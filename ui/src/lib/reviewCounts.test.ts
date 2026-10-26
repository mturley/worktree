import { describe, expect, it } from "vitest"
import { codeTabLabel, countsAreUnread, toolbarLabel } from "./reviewCounts"

describe("reviewCounts", () => {
  it("codeTabLabel", () => {
    expect(codeTabLabel(0, 0, 0)).toBe("Review changes")
    expect(codeTabLabel(2, 5, 3)).toBe("Review changes (2 pending local comments, 5 PR comments (3 unread))")
    expect(codeTabLabel(1, 1, 0)).toBe("Review changes (1 pending local comment, 1 PR comment)")
    expect(codeTabLabel(0, 4, 0)).toBe("Review changes (4 PR comments)")
  })
  it("toolbarLabel", () => {
    expect(toolbarLabel(2, 5, 3)).toBe("2 pending local review comments, 5 PR review comments (3 unread)")
    expect(toolbarLabel(0, 1, 1)).toBe("1 PR review comment (1 unread)")
  })
  it("countsAreUnread", () => {
    expect(countsAreUnread(0, 0)).toBe(false)
    expect(countsAreUnread(0, 1)).toBe(true)
    expect(countsAreUnread(1, 0)).toBe(true)
  })
})
