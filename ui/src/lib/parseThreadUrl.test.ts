import { describe, it, expect } from 'vitest'
import { parseThreadUrl } from './parseThreadUrl'

describe('parseThreadUrl', () => {
  it('parses a reply URL with thread_ts', () => {
    expect(
      parseThreadUrl(
        'https://redhat-internal.slack.com/archives/C0EXAMPLE2/p1700000000000009?thread_ts=1700000000.000005&cid=C0EXAMPLE2',
      ),
    ).toEqual({ channel: 'C0EXAMPLE2', threadTs: '1700000000.000005' })
  })

  it('parses a root message URL (no thread_ts)', () => {
    expect(parseThreadUrl('https://x.slack.com/archives/C0EXAMPLE2/p1700000000000007')).toEqual({
      channel: 'C0EXAMPLE2',
      threadTs: '1700000000.000007',
    })
  })

  it('returns null for non-slack URLs', () => {
    expect(parseThreadUrl('https://example.com/foo')).toBeNull()
  })
})
