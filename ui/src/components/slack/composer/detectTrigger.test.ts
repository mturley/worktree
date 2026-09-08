import { describe, it, expect } from 'vitest'
import { detectTrigger } from './detectTrigger'

describe('detectTrigger', () => {
  it('matches a trigger at the start of the text', () => {
    expect(detectTrigger('@ad')).toEqual({ trigger: '@', query: 'ad', start: 0 })
  })

  it('matches a trigger after whitespace', () => {
    expect(detectTrigger('hello @ad')).toEqual({ trigger: '@', query: 'ad', start: 6 })
  })

  it('matches a bare trigger with an empty query', () => {
    expect(detectTrigger('hello @')).toEqual({ trigger: '@', query: '', start: 6 })
  })

  it('does not match mid-word, so email addresses are left alone', () => {
    expect(detectTrigger('mail ada@example.com')).toBeNull()
  })

  it('closes once the query is broken by whitespace', () => {
    expect(detectTrigger('@ada says')).toBeNull()
  })

  it('handles the : and # triggers', () => {
    expect(detectTrigger('nice :tad')).toEqual({ trigger: ':', query: 'tad', start: 5 })
    expect(detectTrigger('see #odh')).toEqual({ trigger: '#', query: 'odh', start: 4 })
  })

  it('matches after a newline', () => {
    expect(detectTrigger('line one\n@ad')).toEqual({ trigger: '@', query: 'ad', start: 9 })
  })

  it('returns null for text with no trigger', () => {
    expect(detectTrigger('just typing')).toBeNull()
  })
})
