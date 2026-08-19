import { describe, it, expect } from 'vitest'
import { fallbackTitle } from './fallbackTitle'

describe('fallbackTitle', () => {
  it('returns the text unchanged when it is short', () => {
    expect(fallbackTitle('Hello there')).toBe('Hello there')
  })

  it('collapses newlines and repeated whitespace into single spaces', () => {
    expect(fallbackTitle('Hello\n\nthere   friend\t!')).toBe('Hello there friend !')
  })

  it('trims leading/trailing whitespace', () => {
    expect(fallbackTitle('   padded text   ')).toBe('padded text')
  })

  it('truncates to ~60 chars and appends an ellipsis', () => {
    const long = 'a'.repeat(100)
    const result = fallbackTitle(long)
    expect(result.endsWith('…')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(61)
  })

  it('does not truncate text exactly at the limit', () => {
    const exact = 'a'.repeat(60)
    expect(fallbackTitle(exact)).toBe(exact)
  })

  it('returns "" for undefined, empty, or whitespace-only input', () => {
    expect(fallbackTitle(undefined)).toBe('')
    expect(fallbackTitle('')).toBe('')
    expect(fallbackTitle('   \n\t  ')).toBe('')
  })
})
