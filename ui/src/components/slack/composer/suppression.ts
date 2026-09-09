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
 * up. The tiebreak below preserves this: it only ever picks between the two
 * branches' own answers, both of which already satisfy it.
 *
 * AMBIGUOUS DIFFS AND THE TIEBREAK (round 6). Where a diff is genuinely
 * ambiguous the two branches disagree, and BOTH answers are consistent with
 * some single contiguous edit: `"@ad"` → `"@@ad"` could be an insertion at 0
 * (anchor stays at 0) or at 1 (anchor moves to 1), and the two `'@'`s carry
 * no information about which is which. Until round 6 the prefix branch simply
 * won, which produced a user-visible wrong answer: escape `hi @ad`, put the
 * caret at offset 3, type `@bo`, and the suppression re-anchored onto the
 * NEWLY TYPED `'@'` — the menu stayed shut for `@bo` while the old `@ad`
 * went live again.
 *
 * The disambiguating information is already here: the anchored occurrence's
 * own text as of the previous update is `oldText.slice(offset)`. When both
 * candidates are admissible, prefer the one where that text is still found —
 * i.e. the reading under which the anchored occurrence survived intact and
 * the edit happened somewhere else. `"@ad"` matches at 1, not at 0, so the
 * anchor moves to 1 and `@bo` opens its menu.
 *
 * This is a TIEBREAK, never an identity test, and that distinction is what
 * makes it safe where three earlier text-heuristic designs were not (see the
 * list on `SuppressedOccurrence`). It can only choose BETWEEN offsets the
 * diff already deems admissible, so it can never resurrect a deleted anchor
 * or invent a position; and because it decides nothing on its own, a
 * degenerate hint means "no preference" rather than "matches everything" —
 * which is exactly how `startsWith('')` / `endsWith('')` failed before. (The
 * hint is in fact never empty, since `offset < oldText.length`, but the
 * design does not depend on that.) If the hint matches both candidates or
 * neither, the pre-round-6 answer stands unchanged.
 *
 * The mirror case does NOT regress: a trigger typed immediately AFTER an
 * escaped one, `"hi @ad"` → `"hi @ad@bo"`, is not ambiguous at all — the
 * common prefix spans the whole of `oldText`, the common suffix is empty, so
 * only one candidate exists and the tiebreak never runs. Flipping the
 * tiebreak to prefer the suffix branch unconditionally is what would mirror
 * the bug; keying it on the occurrence's own text does not.
 *
 * RESIDUAL LIMITATION, smaller and precisely stated. When the newly typed
 * trigger's text is a prefix of the escaped occurrence's own text, the hint
 * matches at both candidates and cannot discriminate — the old prefix-wins
 * answer stands:
 *
 *     reanchorOffset('hi @ad', 'hi @ad@ad', 3) === 3   // typed "@ad" in front
 *
 * If the user typed that second `@ad` in FRONT of the dismissed one, the
 * anchor should have moved to 6 and does not, so the newly typed occurrence
 * stays suppressed. This is irreducible by diffing — the two occurrences are
 * character-for-character identical over the compared span, so nothing in the
 * text distinguishes them — and unlike round 5's version it now requires the
 * user to retype the same query they just dismissed. A real fix means not
 * diffing at all: anchoring the suppression to a Lexical marker (a PointType
 * maintained through the editor's own transform pipeline, or a zero-width
 * marker node), which costs a node type, its serialization, and its
 * interaction with undo/redo and mention insertion. Still not worth it;
 * revisit if it ever shows up in real use. Pinned by table rows in
 * suppression.test.ts.
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

  const delta = newText.length - oldText.length

  // The pre-tiebreak answer. Every path below either returns this or one of
  // the two candidates it is already choosing between.
  let answer: number | null = null
  if (offset < prefix) {
    answer = offset
  } else if (offset >= oldText.length - suffix) {
    answer = offset + delta
  }

  // Admissibility for the tiebreak is computed against the UNCAPPED common
  // suffix, because the interesting ambiguity is exactly the case where the
  // common prefix and common suffix overlap: "@ad" -> "@@ad" has prefix 1 and
  // an uncapped suffix of 3, and it is that overlap that makes both readings
  // valid. The cap above exists to keep the primary branches from
  // double-counting a shared character, so it must not be reused here.
  const maxSuffixFull = Math.min(oldText.length, newText.length)
  let suffixFull = 0
  while (
    suffixFull < maxSuffixFull &&
    oldText[oldText.length - 1 - suffixFull] === newText[newText.length - 1 - suffixFull]
  ) {
    suffixFull += 1
  }

  const prefixCandidate = offset < prefix ? offset : null
  const suffixCandidate = offset >= oldText.length - suffixFull ? offset + delta : null
  if (prefixCandidate !== null && suffixCandidate !== null && prefixCandidate !== suffixCandidate) {
    // The anchored occurrence's own text at the previous update. Used ONLY to
    // pick between these two, never to decide admissibility.
    const hint = oldText.slice(offset)
    const prefixFits = newText.startsWith(hint, prefixCandidate)
    const suffixFits = newText.startsWith(hint, suffixCandidate)
    if (prefixFits !== suffixFits) {
      return prefixFits ? prefixCandidate : suffixCandidate
    }
  }

  return answer
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
 *
 * The `trigger` comparison is a cheap ASSERTION, not a live discriminator:
 * `nodeText[triggerOffset] === trigger` is an invariant of this module —
 * `reanchorSuppression` rebases `nodeText` on every update and re-anchoring
 * is totally character-preserving, so the character under the anchor is
 * always the recorded trigger. Its unit test therefore asserts a tautology,
 * and no component-level test can kill it (an in-place `@` -> `:` edit
 * deletes the anchored character, so the suppression is dropped by
 * re-anchoring one step earlier). It is kept because it is free and would
 * catch a future change to `detectTrigger` or to the diff that broke the
 * invariant — but it must not be counted as coverage.
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
