import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render } from "@testing-library/react"
import type { FileDiffMetadata } from "@pierre/diffs"
import DescriptionDiff from "./DescriptionDiff"

// pierre renders into shadow DOM, which tests can't see into: stand FileDiff
// in with a component that keeps what it was given.
type MockOptions = Record<string, unknown>
const pierre = vi.hoisted(() => ({ calls: [] as { fileDiff: FileDiffMetadata; options: MockOptions }[] }))
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, options }: { fileDiff: FileDiffMetadata; options: MockOptions }) => {
    pierre.calls.push({ fileDiff, options })
    return <div data-testid="pierre" />
  },
}))

afterEach(() => {
  cleanup()
  pierre.calls.length = 0
})

const last = () => pierre.calls[pierre.calls.length - 1]
const totals = (fd: FileDiffMetadata) => ({
  additions: fd.hunks.reduce((n, h) => n + h.additionLines, 0),
  deletions: fd.hunks.reduce((n, h) => n + h.deletionLines, 0),
})

describe("DescriptionDiff", () => {
  it("ignores a difference in line endings alone", () => {
    render(<DescriptionDiff oldText={"one\r\ntwo\r\nthree\r\n"} newText={"one\ntwo\nthree\n"} cacheKey="e1" />)
    expect(totals(last().fileDiff)).toEqual({ additions: 0, deletions: 0 })
  })

  it("renders word highlights on a 3000-char line", () => {
    const para = "word ".repeat(600)
    render(<DescriptionDiff oldText={`intro\n${para}\noutro\n`} newText={`intro\n${para}more\noutro\n`} cacheKey="e1" />)
    const { fileDiff, options } = last()
    expect(totals(fileDiff)).toEqual({ additions: 1, deletions: 1 })
    expect(options).toMatchObject({
      diffStyle: "unified",
      themeType: "dark",
      lineDiffType: "word",
      maxLineDiffLength: 20000,
      disableFileHeader: true,
    })
  })

  it("shows a description that was added as all additions", () => {
    render(<DescriptionDiff oldText="" newText={"one\ntwo\nthree\n"} cacheKey="e1" />)
    expect(totals(last().fileDiff)).toEqual({ additions: 3, deletions: 0 })
  })

  it("shows a description that was cleared as all deletions", () => {
    render(<DescriptionDiff oldText={"one\ntwo\n"} newText="" cacheKey="e1" />)
    expect(totals(last().fileDiff)).toEqual({ additions: 0, deletions: 2 })
  })

  it("is plain text, never highlighted as a language", () => {
    render(<DescriptionDiff oldText="a" newText="b" cacheKey="e1" />)
    expect(last().fileDiff.lang ?? "text").toBe("text")
  })
})
