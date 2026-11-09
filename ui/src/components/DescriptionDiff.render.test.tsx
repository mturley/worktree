import { describe, expect, it } from "vitest"
import { preloadDiffHTML } from "@pierre/diffs/ssr"
import { DESCRIPTION_DIFF_OPTIONS } from "./DescriptionDiff"

// Not mocked (unlike DescriptionDiff.test.tsx): pierre's server renderer
// produces real HTML with the options DescriptionDiff uses in production.
const render = (oldText: string, newText: string, options: object = DESCRIPTION_DIFF_OPTIONS) =>
  preloadDiffHTML({
    oldFile: { name: "description", contents: oldText },
    newFile: { name: "description", contents: newText },
    options,
  })

// The attribute also appears in the HTML's inline stylesheet; count elements.
const spans = (html: string) => html.match(/<[a-z]+[^>]*\sdata-diff-span[\s>=][^>]*>/g) ?? []

const paragraph = (word: string) => `${"lorem ipsum dolor ".repeat(166)}${word} end`

describe("DescriptionDiff real rendering", () => {
  const oldText = paragraph("alpha")
  const newText = paragraph("bravo")

  it("highlights the changed word on a 3000-character line", async () => {
    expect(oldText.length).toBeGreaterThan(2900)
    const html = await render(oldText, newText)
    expect(spans(html).length).toBeGreaterThan(0)
  })

  it("would not at pierre's default limit (guards the raised cap)", async () => {
    const html = await render(paragraph("charlie"), paragraph("delta"), { ...DESCRIPTION_DIFF_OPTIONS, maxLineDiffLength: 1000 })
    expect(spans(html)).toHaveLength(0)
  })

  it("offers expand controls for unchanged lines around one change", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const edited = [...lines]
    edited[20] = "line twenty"
    const html = await render(lines.join("\n"), edited.join("\n"))
    expect(html.match(/<[a-z]+[^>]*\sdata-expand-button[\s>=]/g) ?? []).not.toHaveLength(0)
  })
})
