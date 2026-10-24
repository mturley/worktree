import { describe, expect, it } from "vitest"
import { lineInHunks, pierreSide, toCommentTarget } from "./commentRange"
import { parseDiff } from "./parsedPatch"

const PATCH = `diff --git a/x.go b/x.go
index 1111111..2222222 100644
--- a/x.go
+++ b/x.go
@@ -1,4 +1,5 @@
+n1
+n2
 a
-b
 c
 d
@@ -20,3 +21,3 @@
 p
-q
+r
 s
diff --git a/old.txt b/renamed.txt
similarity index 90%
rename from old.txt
rename to renamed.txt
index 1111111..2222222 100644
--- a/old.txt
+++ b/renamed.txt
@@ -1,2 +1,2 @@
-one
+uno
 two
`

const files = parseDiff(PATCH, "k")
const x = files[0]
const renamed = files[1]

describe("toCommentTarget", () => {
  it("single new-side line", () => {
    expect(toCommentTarget(x, { start: 4, end: 4, side: "additions" })).toEqual({ file: "x.go", side: "new", start: 4, end: 4 })
  })

  it("defaults an undefined side to additions", () => {
    expect(toCommentTarget(x, { start: 3, end: 4 })).toEqual({ file: "x.go", side: "new", start: 3, end: 4 })
  })

  it("reversed range is normalised", () => {
    expect(toCommentTarget(x, { start: 5, end: 3, side: "additions" })).toEqual({ file: "x.go", side: "new", start: 3, end: 5 })
  })

  it("range across sides clamps to the starting side", () => {
    expect(toCommentTarget(x, { start: 5, side: "additions", end: 2, endSide: "deletions" })).toEqual({
      file: "x.go",
      side: "new",
      start: 5,
      end: 5,
    })
  })

  it("old-side context-only range maps to new side", () => {
    // old a(1) is new 3 (two lines added above it)
    expect(toCommentTarget(x, { start: 1, end: 1, side: "deletions" })).toEqual({ file: "x.go", side: "new", start: 3, end: 3 })
    // lines in the gap after the first hunk carry the +1 offset
    expect(toCommentTarget(x, { start: 10, end: 12, side: "deletions" })).toEqual({ file: "x.go", side: "new", start: 11, end: 13 })
  })

  it("old-side range with a removed line stays old", () => {
    expect(toCommentTarget(x, { start: 1, end: 3, side: "deletions" })).toEqual({ file: "x.go", side: "old", start: 1, end: 3 })
  })

  it("renamed file uses prevName on the old side", () => {
    expect(toCommentTarget(renamed, { start: 1, end: 1, side: "deletions" })).toEqual({
      file: "old.txt",
      side: "old",
      start: 1,
      end: 1,
    })
    expect(toCommentTarget(renamed, { start: 2, end: 2, side: "additions" })?.file).toBe("renamed.txt")
  })

  it("returns null for a binary file", () => {
    expect(toCommentTarget({ ...x, binary: true }, { start: 1, end: 1 })).toBeNull()
  })
})

describe("lineInHunks", () => {
  it("is true inside a hunk and false in the gap between hunks", () => {
    expect(lineInHunks(x.meta, "new", 3)).toBe(true)
    expect(lineInHunks(x.meta, "old", 21)).toBe(true)
    expect(lineInHunks(x.meta, "new", 10)).toBe(false)
    expect(lineInHunks(x.meta, "old", 10)).toBe(false)
  })
})

describe("pierreSide", () => {
  it("maps comment sides to pierre sides", () => {
    expect(pierreSide("old")).toBe("deletions")
    expect(pierreSide("new")).toBe("additions")
  })
})
