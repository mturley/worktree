// Shared emoji-resolution logic used by both RichText (inline `emoji`
// elements) and Message (reaction pills), so the two render consistently.
import { get as lookupStandardEmoji } from 'node-emoji'

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
