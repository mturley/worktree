import type { NodeKey } from 'lexical'
import type { TriggerMatch } from './detectTrigger'

/**
 * Identifies the one trigger *occurrence* the user dismissed with Escape, so
 * it can stay dismissed while the user keeps editing, without ever
 * suppressing a genuinely different trigger.
 *
 * The identity is deliberately POSITIONAL AND EXACT — the text node the
 * trigger lives in, the trigger character, and the offset of that character
 * WITHIN that node — kept correct across edits by re-anchoring the offset on
 * every update (see `reanchorOffset`). Three earlier designs each keyed on a
 * text/position *heuristic* and each had a degenerate input that matched
 * everything:
 *
 *  1. `detectTrigger.start` alone — a BLOCK offset, so editing text before
 *     the trigger shifted it and a dismissed menu reopened.
 *  2. `{nodeKey, trigger, query}` compared with `query.startsWith(...)` —
 *     escaping a bare `@` records `query: ''`, and everything starts with
 *     `''`, so one Escape killed mentions for the whole node.
 *  3. `{nodeKey, trigger, beforeText}` compared with
 *     `beforeText.endsWith(...)` — the same failure mirrored: a trigger at
 *     node offset 0 records `beforeText: ''`, and everything ends with `''`.
 *     Plus suffix over-match on recurring lead-ins like `"cc "`.
 *
 * Integer equality has no wildcard, so there is no analogous degenerate case
 * here; the risk moves entirely into the re-anchoring, which is why that is a
 * pure function with an exhaustive table test of its own.
 */
export interface SuppressedOccurrence {
  nodeKey: NodeKey
  trigger: TriggerMatch['trigger']
  /** The text node's full content as of the last time this record was
   *  re-anchored — the baseline the next edit is diffed against. */
  nodeText: string
  /** Index of the trigger character within `nodeText`. */
  triggerOffset: number
}

/**
 * Maps an offset in `oldText` to the equivalent offset in `newText`, assuming
 * the change between them is a single contiguous replacement (which is what a
 * keystroke, a paste, or a splice is).
 *
 * The replaced range is derived as everything between the longest common
 * prefix and the longest common suffix:
 *
 * - trigger inside the common prefix  → unchanged (the edit is after it)
 * - trigger inside the common suffix  → shifted by the length delta
 * - trigger inside the replaced range → `null`: that occurrence is gone
 *
 * Returns `null` for an offset outside `oldText` (including any offset when
 * `oldText` is empty), which callers treat as "drop the suppression".
 *
 * Note a property both non-null branches share, relied on by the caller: the
 * returned offset always points at the SAME CHARACTER it did before. In the
 * prefix branch that is the definition of a common prefix; in the suffix
 * branch, `offset` lies inside the common suffix, so `newText[offset + delta]
 * === oldText[offset]`. Re-anchoring can therefore never silently slide the
 * anchor onto a different character — it either tracks the trigger or gives
 * up.
 *
 * Where a diff is genuinely ambiguous (repeated characters: `"aaa"` → `"aaaa"`
 * could be an insertion at any of four positions) this resolves it by
 * preferring the longest common prefix, i.e. it treats the change as having
 * happened as late in the string as possible. Any consistent choice is
 * acceptable — the characters involved are identical by definition, so the
 * anchored character is unaffected either way.
 */
export function reanchorOffset(oldText: string, newText: string, offset: number): number | null {
  if (offset < 0 || offset >= oldText.length) {
    return null
  }
  if (oldText === newText) {
    return offset
  }

  const maxPrefix = Math.min(oldText.length, newText.length)
  let prefix = 0
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) {
    prefix += 1
  }

  // Cap the suffix scan so prefix and suffix can never overlap (they would
  // for e.g. "aa" -> "a", double-counting the shared character).
  const maxSuffix = Math.min(oldText.length - prefix, newText.length - prefix)
  let suffix = 0
  while (suffix < maxSuffix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) {
    suffix += 1
  }

  if (offset < prefix) {
    return offset
  }
  const replacedEnd = oldText.length - suffix
  if (offset >= replacedEnd) {
    return offset + (newText.length - oldText.length)
  }
  return null
}

/**
 * Re-anchors a suppression record against its node's current text. Returns
 * the updated record, or `null` when the dismissed occurrence no longer
 * exists (the edit deleted or replaced it) and the suppression should be
 * dropped.
 */
export function reanchorSuppression(
  suppressed: SuppressedOccurrence,
  newNodeText: string,
): SuppressedOccurrence | null {
  const offset = reanchorOffset(suppressed.nodeText, newNodeText, suppressed.triggerOffset)
  if (offset === null) {
    return null
  }
  return { ...suppressed, nodeText: newNodeText, triggerOffset: offset }
}

/**
 * Whether a freshly detected trigger IS the dismissed occurrence, and so must
 * stay closed. All three components must match exactly; `suppressed` is
 * expected to have been re-anchored against the current text first.
 */
export function isSuppressedOccurrence(
  suppressed: SuppressedOccurrence,
  nodeKey: NodeKey,
  trigger: TriggerMatch['trigger'],
  triggerOffset: number,
): boolean {
  return (
    suppressed.nodeKey === nodeKey && suppressed.trigger === trigger && suppressed.triggerOffset === triggerOffset
  )
}
