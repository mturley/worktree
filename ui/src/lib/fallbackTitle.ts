// Shared helper for the "untitled thread" fallback shown in both the
// ThreadView header and TabBar tabs: a short, single-line preview of the
// thread's first message, used instead of a blank/literal placeholder.

const MAX_LENGTH = 60

/**
 * Collapses whitespace/newlines in `text` and truncates it to a short
 * single-line preview (~60 chars, with a trailing "…" if truncated).
 * Returns "" when there's no usable text.
 */
export function fallbackTitle(text: string | undefined): string {
  if (!text) {
    return ''
  }
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (!collapsed) {
    return ''
  }
  if (collapsed.length <= MAX_LENGTH) {
    return collapsed
  }
  return `${collapsed.slice(0, MAX_LENGTH).trimEnd()}…`
}
