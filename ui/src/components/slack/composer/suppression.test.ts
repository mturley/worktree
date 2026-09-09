import { describe, it, expect } from 'vitest'
import {
  reanchorOffset,
  reanchorSuppression,
  isSuppressedOccurrence,
  type SuppressedOccurrence,
} from './suppression'

// Enumerated rather than probe-driven on purpose: the three suppression
// designs this replaces were each broken by a degenerate input (an empty
// query, an empty prefix, a shifted block offset) that a table like this
// would have surfaced immediately, and each was instead found by someone
// clicking around the built component.
describe('reanchorOffset', () => {
  const cases: Array<{ name: string; oldText: string; newText: string; offset: number; expected: number | null }> = [
    // --- degenerate inputs -------------------------------------------------
    { name: 'empty old text', oldText: '', newText: 'abc', offset: 0, expected: null },
    { name: 'empty old text, empty new text', oldText: '', newText: '', offset: 0, expected: null },
    { name: 'empty new text (everything deleted)', oldText: 'hello @ad', newText: '', offset: 6, expected: null },
    { name: 'offset past the end of old text', oldText: 'abc', newText: 'abcd', offset: 3, expected: null },
    { name: 'negative offset', oldText: 'abc', newText: 'abd', offset: -1, expected: null },
    { name: 'identical text (no-op edit)', oldText: 'hello @ad', newText: 'hello @ad', offset: 6, expected: 6 },

    // --- insertions --------------------------------------------------------
    { name: 'insertion before the trigger', oldText: 'hello @ad', newText: 'x hello @ad', offset: 6, expected: 8 },
    {
      name: 'insertion before a trigger at node offset 0',
      oldText: '@ad',
      newText: 'x @ad',
      offset: 0,
      expected: 2,
    },
    { name: 'insertion after the trigger', oldText: 'hello @ad', newText: 'hello @adam', offset: 6, expected: 6 },
    {
      name: 'append far after a trigger at node offset 0',
      oldText: '@',
      newText: '@-team standup at 3, @ada',
      offset: 0,
      expected: 0,
    },
    { name: 'insertion exactly AT the trigger offset', oldText: 'ab@c', newText: 'abX@c', offset: 2, expected: 3 },

    // --- deletions ---------------------------------------------------------
    { name: 'deletion before the trigger', oldText: 'x hello @ad', newText: 'hello @ad', offset: 8, expected: 6 },
    { name: 'deletion after the trigger', oldText: 'hello @adam', newText: 'hello @ad', offset: 6, expected: 6 },
    {
      name: 'deletion of the trigger character itself',
      oldText: 'hello @ad',
      newText: 'hello ad',
      offset: 6,
      expected: null,
    },
    {
      name: 'deletion spanning the trigger',
      oldText: 'hello @ad',
      newText: 'hello d',
      offset: 6,
      expected: null,
    },

    // --- replacements ------------------------------------------------------
    { name: 'whole node replaced', oldText: 'hello @ad', newText: 'zzz', offset: 6, expected: null },
    {
      name: 'in-place replacement of the trigger with a different trigger',
      oldText: 'hello @ad',
      newText: 'hello :ad',
      offset: 6,
      expected: null,
    },
    {
      name: 'replacement after the trigger leaves it anchored',
      oldText: 'cc @ad',
      newText: 'cc @adam and cc @bo',
      offset: 3,
      expected: 3,
    },

    // --- ambiguous diffs (repeated substrings) -----------------------------
    // A naive prefix/suffix diff has no way to know WHICH "a" was inserted;
    // any consistent answer is fine because the characters are identical, so
    // the anchored character is the same either way. These pin the answer so
    // a future change to the diff can't silently move an anchor.
    { name: 'repeated substring "aaa" -> "aaaa", offset before the edit', oldText: 'aaa', newText: 'aaaa', offset: 1, expected: 1 },
    { name: 'repeated substring "aaa" -> "aaaa", offset at the end', oldText: 'aaa', newText: 'aaaa', offset: 2, expected: 2 },
    {
      // Resolved by the round-6 tiebreak, not by the prefix branch: the
      // anchored occurrence's text at offset 1 was "@@", which survives at 0
      // and not at 1, so the reading "the character BEFORE the anchor was
      // deleted" wins. Either answer points at a '@'; this one keeps the
      // occurrence's own text intact.
      name: 'text entirely one repeated character, deletion, early offset',
      oldText: '@@@',
      newText: '@@',
      offset: 1,
      expected: 0,
    },
    {
      name: 'text entirely one repeated character, deletion, offset in the replaced range',
      oldText: '@@@',
      newText: '@@',
      offset: 2,
      expected: null,
    },
    { name: 'prefix/suffix would overlap ("ab" -> "aab"), offset in the suffix', oldText: 'ab', newText: 'aab', offset: 1, expected: 2 },
    {
      // Structurally identical to '@ad' -> '@@ad' @0 below (a duplicated
      // leading character), and answered the same way: the anchored text
      // "ab" is found at 1, not at 0, so the anchor moves with it.
      name: 'prefix/suffix would overlap ("ab" -> "aab"), offset in the prefix',
      oldText: 'ab',
      newText: 'aab',
      offset: 0,
      expected: 1,
    },
    { name: 'collapse to a single repeated character ("aa" -> "a")', oldText: 'aa', newText: 'a', offset: 0, expected: 0 },
    { name: 'collapse to a single repeated character, later offset', oldText: 'aa', newText: 'a', offset: 1, expected: null },

    // --- a trigger typed immediately BEFORE an escaped one (round-6 fix) --
    // Until round 6 these returned the anchor unmoved, because the prefix
    // branch won every ambiguous diff and two identical '@'s carry no
    // information about which is which. The tiebreak supplies the missing
    // information from the anchored occurrence's OWN TEXT: "@ad" is still
    // found at the shifted candidate and not at the unmoved one, so the
    // escaped occurrence moves right and the newly typed trigger is live.
    { name: 'trigger typed directly before the escaped one', oldText: '@ad', newText: '@@ad', offset: 0, expected: 1 },
    {
      name: 'the same, mid-line (the component-test scenario)',
      oldText: 'hi @ad',
      newText: 'hi @bo@ad',
      offset: 3,
      expected: 6,
    },
    {
      // The single-character form of the same edit: 'x @ad' -> 'x @@ad' is
      // '@ad' -> '@@ad' with a two-character lead-in, so it must answer the
      // same way. (Before round 6 this row was labelled a "mirror" and
      // pinned 2 — it was in fact the bug itself, wearing a lead-in.)
      name: 'trigger typed directly before the escaped one, single character',
      oldText: 'x @ad',
      newText: 'x @@ad',
      offset: 2,
      expected: 3,
    },
    // The true mirror — a trigger typed immediately AFTER the escaped one —
    // must NOT move, and is the case a naive "prefer the suffix" tiebreak
    // would break. It is not ambiguous at all: the common prefix spans the
    // whole of oldText and the common suffix is empty, so only one candidate
    // is admissible and the tiebreak never runs.
    { name: 'mirror: trigger typed directly after the escaped one', oldText: 'hi @ad', newText: 'hi @ad@bo', offset: 3, expected: 3 },
    {
      name: 'mirror: a bare trigger typed at the end, after the escaped one',
      oldText: 'x @ad',
      newText: 'x @ad@',
      offset: 2,
      expected: 2,
    },
    // Typing INTO the dismissed occurrence keeps it anchored (the whole point
    // of the suppression: the menu must stay shut while the query grows).
    { name: 'typing into the dismissed occurrence', oldText: 'hi @ad', newText: 'hi @ada', offset: 3, expected: 3 },
    {
      // Backspacing inside the dismissed query: the uncapped common suffix
      // is just "d" (length 1), so suffixCandidate is null and the tiebreak
      // never runs at all — this falls straight through to the ordinary
      // prefix-branch answer. It must not spuriously drop to null.
      name: 'backspacing inside the dismissed query keeps the anchor',
      oldText: 'hi @ad',
      newText: 'hi @d',
      offset: 3,
      expected: 3,
    },
    {
      // Both candidates admissible AND the hint matches both, so there is
      // nothing to choose on: the pre-tiebreak answer stands unchanged. This
      // is the residual limitation, pinned — the user retyped the very query
      // they dismissed, immediately in front of it, and the newly typed
      // occurrence stays suppressed. See reanchorOffset's doc comment.
      name: 'RESIDUAL: retyping the dismissed query directly in front of it',
      oldText: 'hi @ad',
      newText: 'hi @ad@ad',
      offset: 3,
      expected: 3,
    },
    {
      // The hint decides nothing on its own: where both candidates fit it,
      // behaviour is exactly what it was before the tiebreak existed.
      name: 'ambiguous but indistinguishable ("aa" -> "aaa") keeps the old answer',
      oldText: 'aa',
      newText: 'aaa',
      offset: 0,
      expected: 0,
    },
    // Deleting one of two adjacent triggers drops the suppression rather than
    // guessing, since the anchor falls inside the replaced range — the
    // tiebreak cannot resurrect it, because only one candidate is admissible.
    { name: 'one of two adjacent triggers deleted', oldText: '@@ad', newText: '@ad', offset: 1, expected: null },
  ]

  for (const c of cases) {
    it(`${c.name}: "${c.oldText}" -> "${c.newText}" @${c.offset} => ${c.expected}`, () => {
      expect(reanchorOffset(c.oldText, c.newText, c.offset)).toBe(c.expected)
    })
  }

  it('never slides the anchor onto a different character (exhaustive)', () => {
    // Brute-force rather than a walk over the table's own rows: every
    // old/new pair over a small alphabet, at every in-range offset. This is
    // the property the identity depends on — a non-null result must point at
    // the same character, and must be a valid index into newText — so it is
    // worth proving over the whole space instead of over the cases someone
    // thought to write down. (~50k cases, a few tens of ms.)
    const alphabet = ['a', 'b', '@']
    const strings: string[] = ['']
    let frontier: string[] = ['']
    for (let length = 0; length < 4; length += 1) {
      frontier = frontier.flatMap((prefix) => alphabet.map((ch) => prefix + ch))
      strings.push(...frontier)
    }

    const violations: string[] = []
    let checked = 0
    for (const oldText of strings) {
      for (const newText of strings) {
        for (let offset = 0; offset < oldText.length; offset += 1) {
          checked += 1
          const result = reanchorOffset(oldText, newText, offset)
          if (result === null) {
            continue
          }
          if (result < 0 || result >= newText.length) {
            violations.push(`"${oldText}"@${offset} -> "${newText}"@${result}: out of range`)
          } else if (newText[result] !== oldText[offset]) {
            violations.push(
              `"${oldText}"@${offset} ("${oldText[offset]}") -> "${newText}"@${result} ("${newText[result]}")`,
            )
          }
        }
      }
    }
    expect(violations).toEqual([])
    expect(checked).toBeGreaterThan(10000)
  })
})

const base: SuppressedOccurrence = {
  nodeKey: 'k1',
  trigger: '@',
  nodeText: 'hello @ad',
  triggerOffset: 6,
}

describe('reanchorSuppression', () => {
  it('shifts the offset and rebases nodeText when text before the trigger changes', () => {
    expect(reanchorSuppression(base, 'x hello @ad')).toEqual({
      nodeKey: 'k1',
      trigger: '@',
      nodeText: 'x hello @ad',
      triggerOffset: 8,
    })
  })

  it('keeps the offset but still rebases nodeText when text after the trigger changes', () => {
    expect(reanchorSuppression(base, 'hello @ada')).toEqual({
      nodeKey: 'k1',
      trigger: '@',
      nodeText: 'hello @ada',
      triggerOffset: 6,
    })
  })

  it('drops the suppression when the occurrence is edited away', () => {
    expect(reanchorSuppression(base, 'hello there')).toBeNull()
  })

  it('composes across successive edits', () => {
    // Re-anchoring runs on every editor update, so the record is rebased one
    // edit at a time; this is what keeps a long typing run accurate.
    let s: SuppressedOccurrence | null = base
    for (const text of ['xhello @ad', 'xyhello @ad', 'xyzhello @ad']) {
      s = s === null ? null : reanchorSuppression(s, text)
    }
    expect(s).toEqual({ nodeKey: 'k1', trigger: '@', nodeText: 'xyzhello @ad', triggerOffset: 9 })
  })
})

describe('isSuppressedOccurrence', () => {
  it('matches when node key, trigger and offset all agree', () => {
    expect(isSuppressedOccurrence(base, 'k1', '@', 6)).toBe(true)
  })

  it('does not match a different text node', () => {
    expect(isSuppressedOccurrence(base, 'k2', '@', 6)).toBe(false)
  })

  it('does not match a different trigger character', () => {
    // Honest label: `nodeText[triggerOffset] === trigger` is an invariant of
    // this module (re-anchoring rebases nodeText every update and is totally
    // character-preserving), so a caller can never legitimately reach this
    // with a mismatched trigger. This asserts a tautology and exists to keep
    // the assertion honest if that invariant is ever broken — it is not
    // coverage of a reachable behaviour. See isSuppressedOccurrence's doc.
    expect(isSuppressedOccurrence(base, 'k1', ':', 6)).toBe(false)
  })

  it('does not match a different offset in the same node', () => {
    expect(isSuppressedOccurrence(base, 'k1', '@', 13)).toBe(false)
  })

  it('is not satisfied by an offset of 0 (no degenerate wildcard)', () => {
    // The failure shape of all three previous designs: some value ('' as a
    // query, '' as a prefix) that compared true against everything. Integer
    // equality has none, and 0 is the value most likely to be produced by a
    // bug, so it is pinned explicitly.
    const atZero: SuppressedOccurrence = { ...base, nodeText: '@ad', triggerOffset: 0 }
    expect(isSuppressedOccurrence(atZero, 'k1', '@', 0)).toBe(true)
    expect(isSuppressedOccurrence(atZero, 'k1', '@', 7)).toBe(false)
    expect(isSuppressedOccurrence(atZero, 'k1', '@', 21)).toBe(false)
  })
})
