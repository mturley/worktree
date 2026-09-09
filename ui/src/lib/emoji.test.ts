import { describe, it, expect } from 'vitest'
import { standardEmojiNames } from './emoji'

describe('standardEmojiNames', () => {
  // node-emoji@2's search() does `name.match(keyword)` — the query is compiled
  // as a REGULAR EXPRESSION. detectTrigger's query class ([^\s@:#]*) admits
  // ( ) + * ? [ \ and friends, and localCandidates runs inside a useMemo
  // DURING RENDER, so an unescaped metacharacter threw a SyntaxError straight
  // out of ComposerInner's render. LexicalErrorBoundary wraps only the
  // ContentEditable subtree and does not catch it, so the composer unmounted
  // and took the user's in-progress draft with it — for ":)" and ":+1", two of
  // the most-typed strings in a Slack composer.
  const metacharacters = ['+1', ')', '(', '[', '\\', '.', '*', '?', ']', '{', '}', '^', '$', '|', 's(m']
  for (const q of metacharacters) {
    it(`does not throw for a query containing regex metacharacters: ${JSON.stringify(q)}`, () => {
      expect(() => standardEmojiNames(q)).not.toThrow()
    })
  }

  it('treats "+1" literally, and finds the emoji node-emoji actually names "+1"', () => {
    expect(standardEmojiNames('+1')).toContain('+1')
  })

  it('matches as a SUBSTRING, not as a pattern', () => {
    // Escaping is not only a crash fix: an unescaped "." is "any character",
    // so ":sm.le" silently matched "smile" and ":." matched everything up to
    // the cap. Neither is substring matching.
    expect(standardEmojiNames('sm.le')).not.toContain('smile')
    expect(standardEmojiNames('smile')).toContain('smile')
  })

  it('returns nothing for a query no emoji name literally contains', () => {
    expect(standardEmojiNames('.')).toEqual([])
    expect(standardEmojiNames(')')).toEqual([])
  })

  it('still ranks shortest-first and caps the list', () => {
    const names = standardEmojiNames('smile')
    expect(names[0]).toBe('smile')
    expect(names.length).toBeLessThanOrEqual(25)
  })
})
