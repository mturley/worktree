// A list item's bullet (or number), its spacing, then a GFM task marker.
const TASK_ITEM = /^((?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])\]/

/**
 * Flips the GFM task marker of the list item that starts at `offset` in
 * `text` — "[ ]" becomes "[x]" and "[x]"/"[X]" becomes "[ ]" — changing
 * nothing else.
 *
 * `offset` comes from the Markdown renderer's source position for the item.
 * Returns null when no task marker is exactly there, so a stale or wrong
 * offset leaves the text alone instead of editing the wrong line.
 */
export function toggleTaskAt(text: string, offset: number): string | null {
  if (offset < 0 || offset >= text.length) return null
  const m = TASK_ITEM.exec(text.slice(offset))
  if (!m) return null
  const markerAt = offset + m[1].length
  const next = m[2] === " " ? "x" : " "
  return text.slice(0, markerAt) + next + text.slice(markerAt + 1)
}
