import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs"
import type { CommentSide } from "../../api/types"
import type { DiffFile } from "./parsedPatch"

/** Where a review comment attaches: a file, a side and an inclusive line range. */
export interface CommentTarget {
  file: string
  side: CommentSide
  start: number
  end: number
}

export const pierreSide = (s: CommentSide): "deletions" | "additions" => (s === "old" ? "deletions" : "additions")

/** True when `line` lies inside any hunk on the given side. */
export function lineInHunks(meta: FileDiffMetadata, side: CommentSide, line: number): boolean {
  return meta.hunks.some((h) => {
    const start = side === "old" ? h.deletionStart : h.additionStart
    const count = side === "old" ? h.deletionCount : h.additionCount
    return line >= start && line <= start + count - 1
  })
}

// First line a hunk covers on a side. A zero-count side is anchored on the
// line BEFORE the change in a git hunk header, so it covers nothing.
const firstLine = (start: number, count: number): number => (count === 0 ? start + 1 : start)

/**
 * Maps an old-side line to its new-side number when the line is unchanged
 * context, or null when the line was removed.
 */
function oldToNew(meta: FileDiffMetadata, line: number): number | null {
  let offset = 0 // new - old for lines in the gap after the previous hunk
  for (const h of meta.hunks) {
    const oldFirst = firstLine(h.deletionStart, h.deletionCount)
    const newFirst = firstLine(h.additionStart, h.additionCount)
    if (line < oldFirst) return line + offset
    if (line < oldFirst + h.deletionCount) {
      let oldPos = oldFirst
      let newPos = newFirst
      for (const c of h.hunkContent) {
        if (c.type === "context") {
          if (line < oldPos + c.lines) return newPos + (line - oldPos)
          oldPos += c.lines
          newPos += c.lines
        } else {
          if (line < oldPos + c.deletions) return null
          oldPos += c.deletions
          newPos += c.additions
        }
      }
      return null
    }
    offset = newFirst + h.additionCount - (oldFirst + h.deletionCount)
  }
  return line + offset
}

/**
 * Turns a pierre line selection into a comment target. Returns null for a
 * binary file. A selection that spans both sides clamps to the single line it
 * started on. An old-side selection of only unchanged lines becomes a
 * new-side comment, since those lines still exist in the file.
 */
export function toCommentTarget(f: DiffFile, range: SelectedLineRange): CommentTarget | null {
  if (f.binary) return null
  const { meta } = f
  const startSide = range.side ?? "additions"
  let start = Math.min(range.start, range.end)
  let end = Math.max(range.start, range.end)
  if (range.endSide && range.endSide !== startSide) {
    start = range.start
    end = range.start
  }
  if (startSide === "additions") return { file: meta.name, side: "new", start, end }

  const mapped: number[] = []
  for (let l = start; l <= end; l++) {
    const n = oldToNew(meta, l)
    if (n === null) return { file: meta.prevName ?? meta.name, side: "old", start, end }
    mapped.push(n)
  }
  return { file: meta.name, side: "new", start: mapped[0], end: mapped[mapped.length - 1] }
}
