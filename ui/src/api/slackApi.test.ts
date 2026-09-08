import { describe, it, expect, vi, afterEach } from 'vitest'
import { safeHref, unescapeSlackText, imageProxy, autocomplete } from './slackApi'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

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

describe('imageProxy', () => {
  it('routes an https URL through the open-host image proxy', () => {
    expect(imageProxy('https://cdn.example.com/favicon.ico')).toBe(
      '/api/slack-image?url=' + encodeURIComponent('https://cdn.example.com/favicon.ico'),
    )
  })

  it('leaves a non-https URL unchanged so the <img> onError fallback still applies', () => {
    expect(imageProxy('http://cdn.example.com/x.png')).toBe('http://cdn.example.com/x.png')
  })

  it('leaves an empty URL unchanged', () => {
    expect(imageProxy('')).toBe('')
  })
})

describe('autocomplete', () => {
  it('sends the trigger, query and channel, and returns results', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ kind: 'user', id: 'U1', label: 'ada', detail: 'aroberts', token: '<@U1>' }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const items = await autocomplete('@', 'ad', 'C1')

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/api/slack-autocomplete')
    expect(url).toContain('trigger=%40')
    expect(url).toContain('q=ad')
    expect(url).toContain('channel=C1')
    expect(items).toEqual([
      { kind: 'user', id: 'U1', label: 'ada', detail: 'aroberts', token: '<@U1>' },
    ])
  })

  it('returns [] rather than throwing when the server errors, so the menu keeps local results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => 'boom' }))
    await expect(autocomplete('@', 'ad', 'C1')).resolves.toEqual([])
  })
})
