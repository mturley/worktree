import { describe, expect, it } from "vitest"
import { fileAnchorId, parseDiff } from "./parsedPatch"

const PATCH = `diff --git a/img.png b/img.png
index 1111111..2222222 100644
Binary files a/img.png and b/img.png differ
diff --git a/new.png b/new.png
new file mode 100644
index 0000000..2222222
Binary files /dev/null and b/new.png differ
diff --git a/x.go b/x.go
index 1111111..2222222 100644
--- a/x.go
+++ b/x.go
@@ -1,4 +1,4 @@
 a
-b
+c
+e
 d
diff --git a/ui/package-lock.json b/ui/package-lock.json
index 1111111..2222222 100644
--- a/ui/package-lock.json
+++ b/ui/package-lock.json
@@ -1,1 +1,1 @@
-{}
+{"a":1}
diff --git a/old.txt b/renamed.txt
similarity index 100%
rename from old.txt
rename to renamed.txt
`

function bigPatch(lines: number) {
  const added = Array.from({ length: lines }, (_, i) => `+line ${i}`).join("\n")
  return `diff --git a/big.txt b/big.txt
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/big.txt
@@ -0,0 +1,${lines} @@
${added}
`
}

describe("parseDiff", () => {
  it("lists every file in the patch with its change type", () => {
    const files = parseDiff(PATCH, "k")
    expect(files.map((f) => [f.path, f.type])).toEqual([
      ["img.png", "change"],
      ["new.png", "new"],
      ["x.go", "change"],
      ["ui/package-lock.json", "change"],
      ["renamed.txt", "rename-pure"],
    ])
    expect(files[4].prevPath).toBe("old.txt")
  })

  it("counts added and removed lines per file", () => {
    const x = parseDiff(PATCH, "k").find((f) => f.path === "x.go")!
    expect([x.additions, x.deletions]).toEqual([2, 1])
  })

  it("marks binary files, on either side", () => {
    const files = parseDiff(PATCH, "k")
    expect(files.filter((f) => f.binary).map((f) => f.path)).toEqual(["img.png", "new.png"])
  })

  it("starts lockfiles collapsed", () => {
    const files = parseDiff(PATCH, "k")
    expect(files.find((f) => f.path === "ui/package-lock.json")!.autoCollapse).toBe(true)
    expect(files.find((f) => f.path === "x.go")!.autoCollapse).toBe(false)
  })

  it("starts files over 1,500 changed lines collapsed", () => {
    expect(parseDiff(bigPatch(1500), "k")[0].autoCollapse).toBe(false)
    expect(parseDiff(bigPatch(1501), "k")[0].autoCollapse).toBe(true)
  })

  it("returns nothing for an empty patch", () => {
    expect(parseDiff("", "k")).toEqual([])
  })
})

describe("fileAnchorId", () => {
  it("is stable and distinct per path", () => {
    expect(fileAnchorId("a/b.go")).toBe(fileAnchorId("a/b.go"))
    expect(fileAnchorId("a/b.go")).not.toBe(fileAnchorId("a/c.go"))
  })
})
