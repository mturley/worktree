import { describe, expect, it } from "vitest"
import type { ReviewCommentItem } from "../../api/types"
import { buildPrompt } from "./buildPrompt"

const item = (over: Partial<ReviewCommentItem> = {}): ReviewCommentItem => ({
  id: 1, source: "draft", editable: true, file: "a/b.go", side: "new", start_line: 3, end_line: 3,
  rev: "abc", base: "merge-base", base_ref: "main", snippet: ["x := 1"], body: "fix this",
  version: 1, created_at: "", updated_at: "",
  prompt: { status: "current", start_line: 3, end_line: 3 },
  ...over,
})
const base = { directory: "/w/d", branch: "feat", baseRef: "main" }

describe("buildPrompt", () => {
  it("formats the header with branch", () => {
    expect(buildPrompt({ ...base, comments: [item()] })).toBe(
      "Review comments on /w/d (branch feat, changes vs main):\n\n1. a/b.go:3\n   ```go\n   x := 1\n   ```\n   fix this\n",
    )
  })
  it("omits branch when detached", () => {
    expect(buildPrompt({ ...base, branch: undefined, comments: [] })).toBe(
      "Review comments on /w/d (changes vs main):\n",
    )
  })
  it("single-line and range locations", () => {
    const out = buildPrompt({
      ...base,
      comments: [item(), item({ id: 2, snippet: ["a", "b"], body: "two", prompt: { status: "moved", start_line: 7, end_line: 8 } })],
    })
    expect(out).toBe(
      "Review comments on /w/d (branch feat, changes vs main):\n\n" +
        "1. a/b.go:3\n   ```go\n   x := 1\n   ```\n   fix this\n\n" +
        "2. a/b.go:7-8\n   ```go\n   a\n   b\n   ```\n   two\n",
    )
  })
  it("removed line and removed lines with en dash", () => {
    const out = buildPrompt({
      ...base,
      comments: [
        item({ prompt: { status: "removed", start_line: 4, end_line: 4 } }),
        item({ id: 2, prompt: { status: "removed", start_line: 4, end_line: 6 } }),
      ],
    })
    expect(out).toContain("1. a/b.go (removed line, previously 4)\n")
    expect(out).toContain("2. a/b.go (removed lines, previously 4–6)\n")
  })
  it("out of date uses the anchored lines", () => {
    const out = buildPrompt({
      ...base,
      comments: [item({ start_line: 10, end_line: 12, prompt: { status: "outdated", start_line: 3, end_line: 3 } })],
    })
    expect(out).toContain("1. a/b.go:10-12 (out of date — this code has since changed; it was:)\n")
  })
  it("indents multi-line bodies", () => {
    expect(buildPrompt({ ...base, comments: [item({ body: "one\ntwo" })] })).toContain("   one\n   two\n")
  })
  it("lengthens the fence around backticks", () => {
    const out = buildPrompt({ ...base, comments: [item({ file: "a.md", snippet: ["```js", "x", "```"] })] })
    expect(out).toBe(
      "Review comments on /w/d (branch feat, changes vs main):\n\n1. a.md:3\n   ````markdown\n   ```js\n   x\n   ```\n   ````\n   fix this\n",
    )
  })
  it("no language for unknown extensions", () => {
    expect(buildPrompt({ ...base, comments: [item({ file: "Makefile" }), item({ file: "x.zzz" })] })).toBe(
      "Review comments on /w/d (branch feat, changes vs main):\n\n" +
        "1. Makefile:3\n   ```\n   x := 1\n   ```\n   fix this\n\n" +
        "2. x.zzz:3\n   ```\n   x := 1\n   ```\n   fix this\n",
    )
  })
})
