// Shared emoji-resolution logic used by both RichText (inline `emoji`
// elements) and Message (reaction pills), so the two render consistently.
import { get as lookupStandardEmoji, search as searchStandardEmoji } from 'node-emoji'

/** Escapes every regex metacharacter so a string is matched literally.
 *
 * REQUIRED here, not defensive: node-emoji@2's `search()` implements matching
 * as `name.match(keyword)`, which COMPILES THE QUERY AS A REGULAR EXPRESSION.
 * `detectTrigger`'s query class (`[^\s@:#]*`) admits `(`, `)`, `+`, `*`, `?`,
 * `[` and `\`, and `localCandidates` runs inside a `useMemo` during RENDER —
 * so `:)` or `:+1`, two of the most-typed strings in a Slack composer, threw
 * a SyntaxError out of ComposerInner's render. LexicalErrorBoundary wraps only
 * the ContentEditable subtree and does not catch that, so the composer
 * unmounted and the user's in-progress draft was lost.
 *
 * Escaping also restores the substring semantics this function's contract
 * claims: unescaped, `.` meant "any character", so `:sm.le` matched `smile`
 * and `:.` matched everything up to the cap. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Standard (Unicode) emoji names containing `query` as a LITERAL substring,
 * shortest (closest) first then alphabetically — the same ordering the server
 * applies to the CUSTOM half in internal/webui/autocomplete.go, so the two
 * halves of the composer's `:` menu are ranked consistently.
 *
 * This is the ONLY place node-emoji is searched: the composer's emoji
 * candidates go through here so emoji knowledge stays in one module. */
export function standardEmojiNames(query: string, limit = 25): string[] {
  if (!query) {
    return []
  }
  const names = searchStandardEmoji(escapeRegex(query.toLowerCase())).map((e) => e.name)
  names.sort((a, b) => (a.length !== b.length ? a.length - b.length : a.localeCompare(b)))
  return names.slice(0, limit)
}

/**
 * Converts a Slack `unicode` field — a hyphen-separated sequence of hex
 * codepoints (e.g. "1f605", or multi-codepoint sequences like
 * "1f468-200d-1f4bb") — into the actual character(s). Returns null if any
 * segment fails to parse as a hex codepoint.
 */
export function unicodeFromCodepoints(codepoints: string): string | null {
  const parts = codepoints.split('-')
  const chars: string[] = []
  for (const part of parts) {
    const code = parseInt(part, 16)
    if (Number.isNaN(code)) {
      return null
    }
    chars.push(String.fromCodePoint(code))
  }
  return chars.join('')
}

export type ResolvedEmoji =
  | { kind: 'unicode'; char: string }
  | { kind: 'image'; url: string }
  | { kind: 'fallback'; text: string }

/**
 * Resolves an emoji reference to something renderable, in priority order:
 * 1. An explicit Slack `unicode` codepoint sequence, if present and valid.
 * 2. A custom workspace emoji image, if `name` is in the server-provided
 *    `emojiMap` (built from emoji.list, so it only contains custom emoji).
 * 3. A standard Unicode emoji glyph resolved by name via node-emoji (covers
 *    reactions and elements that only carry a name like "sweat_smile").
 * 4. A `:name:` text fallback.
 */
export function resolveEmoji(
  name: string,
  unicode: string | undefined,
  emojiMap: Record<string, string>,
): ResolvedEmoji {
  if (unicode) {
    const char = unicodeFromCodepoints(unicode)
    if (char) {
      return { kind: 'unicode', char }
    }
  }
  const customUrl = emojiMap[name]
  if (customUrl) {
    return { kind: 'image', url: customUrl }
  }
  const glyph = lookupStandardEmoji(name)
  if (glyph) {
    return { kind: 'unicode', char: glyph }
  }
  return { kind: 'fallback', text: `:${name}:` }
}
