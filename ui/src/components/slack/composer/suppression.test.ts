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
    { name: 'text entirely one repeated character, deletion, early offset', oldText: '@@@', newText: '@@', offset: 1, expected: 1 },
    {
      name: 'text entirely one repeated character, deletion, offset in the replaced range',
      oldText: '@@@',
      newText: '@@',
      offset: 2,
      expected: null,
    },
    { name: 'prefix/suffix would overlap ("ab" -> "aab"), offset in the suffix', oldText: 'ab', newText: 'aab', offset: 1, expected: 2 },
    { name: 'prefix/suffix would overlap ("ab" -> "aab"), offset in the prefix', oldText: 'ab', newText: 'aab', offset: 0, expected: 0 },
    { name: 'collapse to a single repeated character ("aa" -> "a")', oldText: 'aa', newText: 'a', offset: 0, expected: 0 },
    { name: 'collapse to a single repeated character, later offset', oldText: 'aa', newText: 'a', offset: 1, expected: null },
  ]

  for (const c of cases) {
    it(`${c.name}: "${c.oldText}" -> "${c.newText}" @${c.offset} => ${c.expected}`, () => {
      expect(reanchorOffset(c.oldText, c.newText, c.offset)).toBe(c.expected)
    })
  }

  it('never slides the anchor onto a different character', () => {
    // The property the caller relies on: a non-null result points at the same
    // character it did before the edit, so a suppression can never end up
    // anchored to something that is no longer its trigger.
    for (const c of cases) {
      const result = reanchorOffset(c.oldText, c.newText, c.offset)
      if (result === null) {
        continue
      }
      // The case name rides along in the compared value so a failure names
      // the offending row rather than just "expected 'a' to be '@'".
      expect(`${c.name}: ${c.newText[result]}`).toBe(`${c.name}: ${c.oldText[c.offset]}`)
    }
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
