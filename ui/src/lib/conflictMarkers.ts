// Git-style conflict markers, as the server writes into notes when the
// worktree notes and the cmux description were both edited.
const START = "<<<<<<< "
const MIDDLE = "======="
const END = ">>>>>>> "

const isFence = (line: string) => /^\s*(```|~~~)/.test(line)

/**
 * Line indices of marker lines that belong to an in-order start / middle /
 * end triple outside fenced code. A lone "=======" (a setext heading) or an
 * incomplete triple is not included.
 */
function markerLines(lines: string[]): Set<number> {
  const found = new Set<number>()
  let inFence = false
  let start = -1
  let middle = -1
  lines.forEach((line, i) => {
    if (isFence(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    if (line.startsWith(START)) {
      start = i
      middle = -1
    } else if (line === MIDDLE) {
      if (start >= 0 && middle < 0) middle = i
    } else if (line.startsWith(END) && start >= 0 && middle >= 0) {
      found.add(start).add(middle).add(i)
      start = -1
      middle = -1
    }
  })
  return found
}

export function hasConflictMarkers(text: string): boolean {
  return markerLines(text.split("\n")).size > 0
}

/**
 * Each conflict marker line becomes inline code on a paragraph of its own, so
 * Markdown shows it as written ("=======" would otherwise turn the line above
 * into a heading).
 */
export function literalConflictMarkers(text: string): string {
  const lines = text.split("\n")
  const markers = markerLines(lines)
  if (markers.size === 0) return text
  const out: string[] = []
  const blankBefore = () => {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("")
  }
  lines.forEach((line, i) => {
    if (markers.has(i)) {
      blankBefore()
      out.push(`\`${line}\``)
      if (i < lines.length - 1 && lines[i + 1] !== "") out.push("")
    } else {
      out.push(line)
    }
  })
  return out.join("\n")
}
