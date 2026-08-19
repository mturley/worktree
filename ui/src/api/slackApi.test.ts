import { describe, it, expect } from 'vitest'
import { safeHref, unescapeSlackText } from './slackApi'

describe('unescapeSlackText', () => {
  it('unescapes &amp; &lt; &gt; only', () => {
    expect(unescapeSlackText('&amp;&lt;&gt;')).toBe('&<>')
  })

  it('leaves other text untouched', () => {
    expect(unescapeSlackText('hello *world*')).toBe('hello *world*')
  })
})

describe('safeHref', () => {
  it('allows http, https, and mailto URLs', () => {
    expect(safeHref('http://example.com')).toBe('http://example.com')
    expect(safeHref('https://example.com')).toBe('https://example.com')
    expect(safeHref('mailto:a@example.com')).toBe('mailto:a@example.com')
  })

  it('allows a mixed-case scheme', () => {
    expect(safeHref('HTTPS://example.com')).toBe('HTTPS://example.com')
  })

  it('rejects javascript, data, and vbscript schemes', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined()
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    expect(safeHref('vbscript:msgbox(1)')).toBeUndefined()
  })

  it('rejects a URL with leading whitespace before a disallowed scheme', () => {
    expect(safeHref('  javascript:alert(1)')).toBeUndefined()
  })
})
