import { describe, expect, it } from "vitest"
import { hasConflictMarkers, literalConflictMarkers } from "./conflictMarkers"

const conflict = "a\n<<<<<<< notes\nx\n=======\ny\n>>>>>>> cmux\nb"

describe("conflictMarkers", () => {
  it("wraps each marker line in backticks, set apart by blank lines", () => {
    expect(literalConflictMarkers(conflict)).toBe(
      "a\n\n`<<<<<<< notes`\n\nx\n\n`=======`\n\ny\n\n`>>>>>>> cmux`\n\nb",
    )
  })

  it("adds no leading or trailing blank line, and does not double existing ones", () => {
    expect(literalConflictMarkers("<<<<<<< notes\n\nx\n=======\n\ny\n>>>>>>> other edit")).toBe(
      "`<<<<<<< notes`\n\nx\n\n`=======`\n\ny\n\n`>>>>>>> other edit`",
    )
  })

  it("detects an in-order triple", () => {
    expect(hasConflictMarkers(conflict)).toBe(true)
  })

  it("ignores markers inside a fenced code block", () => {
    const fenced = "```\n<<<<<<< notes\nx\n=======\ny\n>>>>>>> cmux\n```"
    expect(hasConflictMarkers(fenced)).toBe(false)
    expect(literalConflictMarkers(fenced)).toBe(fenced)
  })

  it("leaves a lone ======= (setext heading) alone", () => {
    const text = "Title\n=======\n- [ ] t"
    expect(hasConflictMarkers(text)).toBe(false)
    expect(literalConflictMarkers(text)).toBe(text)
  })

  it("requires the markers in order", () => {
    expect(hasConflictMarkers(">>>>>>> cmux\n=======\n<<<<<<< notes")).toBe(false)
    expect(hasConflictMarkers("<<<<<<< notes\nx\n=======")).toBe(false)
  })
})
