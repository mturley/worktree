import { describe, expect, it } from "vitest"
import { codeTabLabel, countsAreUnread, toolbarLabel } from "./reviewCounts"

describe("reviewCounts", () => {
  it("codeTabLabel", () => {
    expect(codeTabLabel(0, 0, 0, 0)).toBe("Review changes")
    expect(codeTabLabel(2, 5, 3, 0)).toBe("Review changes (2 pending local comments, 5 PR comments (3 unread))")
    expect(codeTabLabel(1, 1, 0, 0)).toBe("Review changes (1 pending local comment, 1 PR comment)")
    expect(codeTabLabel(0, 4, 0, 0)).toBe("Review changes (4 PR comments)")
    expect(codeTabLabel(0, 4, 0, 2)).toBe("Review changes (4 PR comments, pending PR review)")
    expect(codeTabLabel(0, 0, 0, 1)).toBe("Review changes (pending PR review)")
  })
  it("toolbarLabel", () => {
    expect(toolbarLabel(2, 5, 3, 0)).toBe("2 pending local review comments, 5 PR review comments (3 unread)")
    expect(toolbarLabel(0, 1, 1, 0)).toBe("1 PR review comment (1 unread)")
    expect(toolbarLabel(2, 5, 3, 2)).toBe(
      "2 pending local review comments, 5 PR review comments (3 unread), pending PR review (2 comments)",
    )
    expect(toolbarLabel(0, 0, 0, 1)).toBe("pending PR review (1 comment)")
  })
  it("countsAreUnread", () => {
    expect(countsAreUnread(0, 0, 0)).toBe(false)
    expect(countsAreUnread(0, 1, 0)).toBe(true)
    expect(countsAreUnread(1, 0, 0)).toBe(true)
    expect(countsAreUnread(0, 0, 1)).toBe(true)
  })
})
