import { afterEach, describe, it, expect } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { Mrkdwn } from './mrkdwn'
import type { User } from '../api/slackApi'

// RTL's queries are scoped to document.body by default; without cleanup
// between tests, renders from earlier tests remain in the DOM and multi-test
// files start matching multiple elements.
afterEach(cleanup)

// jsdom doesn't implement window.matchMedia; MantineProvider's color-scheme
// effect needs it, so stub a minimal version for this test file only.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function renderWithProvider(ui: React.ReactElement) {
  return render(<MantineProvider>{ui}</MantineProvider>)
}

const users: Record<string, User> = {
  U1: { ID: 'U1', RealName: 'Jane Doe', DisplayName: 'jane', Avatar72: '' },
}

describe('Mrkdwn', () => {
  it('renders plain text with entity unescape', () => {
    // Passed as a JS expression, not a JSX string-literal attribute — JSX
    // decodes HTML entities in string-literal attributes at parse time,
    // which would make this pass even without any unescape logic.
    const { container } = renderWithProvider(<Mrkdwn text={'a &amp; b'} users={{}} emoji={{}} />)
    expect(container.textContent).toContain('a & b')
  })

  it('resolves a known user mention to @DisplayName', () => {
    const { container } = renderWithProvider(<Mrkdwn text="hi <@U1>" users={users} emoji={{}} />)
    expect(container.textContent).toContain('@jane')
    const span = container.querySelector('span')
    expect(span?.textContent).toBe('@jane')
  })

  it('falls back to @Uxxxx for an unknown user mention', () => {
    const { container } = renderWithProvider(<Mrkdwn text="hi <@U9999>" users={users} emoji={{}} />)
    expect(container.textContent).toContain('@U9999')
  })

  it('renders a subteam mention with an explicit name', () => {
    const { container } = renderWithProvider(
      <Mrkdwn text="<!subteam^S1|@eng-team>" users={{}} emoji={{}} />,
    )
    expect(container.querySelector('span')?.textContent).toBe('@eng-team')
  })

  it('renders a subteam mention without a pipe using the group id, not a generic word', () => {
    // Phase D: an unresolved group must stay identifiable. "@subteam" told
    // you nothing and looked identical for every group; the id at least
    // distinguishes them, and mirrors the "@U999" fallback for users.
    const { container } = renderWithProvider(<Mrkdwn text="<!subteam^S1>" users={{}} emoji={{}} />)
    expect(container.querySelector('[data-slack-mention="true"]')?.textContent).toBe('@S1')
  })

  it('renders <!here> and <!channel> broadcasts', () => {
    const { container: c1 } = renderWithProvider(<Mrkdwn text="<!here>" users={{}} emoji={{}} />)
    expect(c1.querySelector('span')?.textContent).toBe('@here')
    cleanup()
    const { container: c2 } = renderWithProvider(<Mrkdwn text="<!channel>" users={{}} emoji={{}} />)
    expect(c2.querySelector('span')?.textContent).toBe('@channel')
  })

  it('renders a link with a label', () => {
    const { container } = renderWithProvider(
      <Mrkdwn text="<https://example.com|Example>" users={{}} emoji={{}} />,
    )
    const a = container.querySelector('a')
    expect(a).not.toBeNull()
    expect(a?.getAttribute('href')).toBe('https://example.com')
    expect(a?.textContent).toBe('Example')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toBe('noreferrer')
  })

  it('renders a bare link using the url as text', () => {
    const { container } = renderWithProvider(<Mrkdwn text="<https://example.com>" users={{}} emoji={{}} />)
    const a = container.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.com')
    expect(a?.textContent).toBe('https://example.com')
  })

  it('resolves a standard emoji name to a glyph', () => {
    const { container } = renderWithProvider(<Mrkdwn text="party :tada:" users={{}} emoji={{}} />)
    expect(container.textContent).not.toContain(':tada:')
    expect(container.textContent).toContain('🎉')
  })

  it('renders a custom emoji from the emoji map as an image', () => {
    const emoji = { partyparrot: 'https://emoji.slack-edge.com/T0/partyparrot/abc.gif' }
    const { container } = renderWithProvider(<Mrkdwn text=":partyparrot:" users={{}} emoji={emoji} />)
    const img = container.querySelector('img[alt=":partyparrot:"]')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toContain('/api/slack-emoji?url=')
  })

  it('renders an unknown emoji name as literal text', () => {
    const { container } = renderWithProvider(<Mrkdwn text=":not_a_real_emoji_xyz:" users={{}} emoji={{}} />)
    expect(container.textContent).toContain(':not_a_real_emoji_xyz:')
  })

  it('renders inline styles: bold, italic, strike, code', () => {
    const { container: c1 } = renderWithProvider(<Mrkdwn text="*bold*" users={{}} emoji={{}} />)
    expect(c1.querySelector('strong')?.textContent).toBe('bold')
    cleanup()
    const { container: c2 } = renderWithProvider(<Mrkdwn text="_italic_" users={{}} emoji={{}} />)
    expect(c2.querySelector('em')?.textContent).toBe('italic')
    cleanup()
    const { container: c3 } = renderWithProvider(<Mrkdwn text="~strike~" users={{}} emoji={{}} />)
    expect(c3.querySelector('del')?.textContent).toBe('strike')
    cleanup()
    const { container: c4 } = renderWithProvider(<Mrkdwn text="`code`" users={{}} emoji={{}} />)
    expect(c4.querySelector('code')?.textContent).toBe('code')
  })

  it('leaves an unpaired asterisk as literal text', () => {
    const { container } = renderWithProvider(<Mrkdwn text="a * b" users={{}} emoji={{}} />)
    expect(container.querySelector('strong')).toBeNull()
    expect(container.textContent).toContain('a * b')
  })

  it('does not interpret style markers inside a code span', () => {
    const { container } = renderWithProvider(<Mrkdwn text="`a * b`" users={{}} emoji={{}} />)
    const code = container.querySelector('code')
    expect(code?.textContent).toBe('a * b')
    expect(container.querySelector('strong')).toBeNull()
  })

  it('renders a mixed string with mention, link, emoji, and bold in order', () => {
    const { container } = renderWithProvider(
      <Mrkdwn
        text="hey <@U1> check <https://example.com|this> :tada: *now*"
        users={users}
        emoji={{}}
      />,
    )
    const text = container.textContent ?? ''
    const idxMention = text.indexOf('@jane')
    const idxLink = text.indexOf('this')
    const idxTada = text.indexOf('🎉')
    const idxBold = text.indexOf('now')
    expect(idxMention).toBeGreaterThan(-1)
    expect(idxLink).toBeGreaterThan(idxMention)
    expect(idxTada).toBeGreaterThan(idxLink)
    expect(idxBold).toBeGreaterThan(idxTada)
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    expect(container.querySelector('strong')?.textContent).toBe('now')
  })

  it('does not treat an escaped angle-bracket mention as a real mention', () => {
    // Passed as a JS expression (not a JSX string-literal attribute), since
    // JSX decodes HTML entities in string-literal attribute values at parse
    // time — `text="&lt;@U1&gt;"` would already be real "<@U1>" by the time
    // the component saw it, defeating the point of this guard.
    const { container } = renderWithProvider(<Mrkdwn text={'&lt;@U1&gt;'} users={users} emoji={{}} />)
    expect(container.textContent).toContain('<@U1>')
    expect(container.querySelector('span')).toBeNull()
  })

  it('does not render an anchor for an unsafe URL scheme', () => {
    const { container } = renderWithProvider(
      <Mrkdwn text="<javascript:alert(1)|click>" users={{}} emoji={{}} />,
    )
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('click')
  })

  it('still renders an anchor for a safe URL scheme', () => {
    const { container } = renderWithProvider(<Mrkdwn text="<https://x.com|ok>" users={{}} emoji={{}} />)
    expect(container.querySelector('a')).not.toBeNull()
  })

  it('entity-unescapes the URL portion of a link token before checking its scheme', () => {
    const { container } = renderWithProvider(
      <Mrkdwn text={'<https://x.com?a=1&amp;b=2|lbl>'} users={{}} emoji={{}} />,
    )
    const a = container.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://x.com?a=1&b=2')
  })

  it('renders nothing for empty text', () => {
    const { container } = renderWithProvider(<Mrkdwn text={''} users={{}} emoji={{}} />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('span')).toBeNull()
  })

  it('keeps bold styling around an emoji token', () => {
    const { container } = renderWithProvider(<Mrkdwn text="*bold :tada: text*" users={{}} emoji={{}} />)
    const strong = container.querySelector('strong')
    expect(strong).not.toBeNull()
    expect(strong?.textContent).not.toContain(':tada:')
    expect(strong?.textContent).toContain('🎉')
  })

  it('does not resolve emoji inside a code span', () => {
    const { container } = renderWithProvider(<Mrkdwn text="`no :tada: here`" users={{}} emoji={{}} />)
    const code = container.querySelector('code')
    expect(code?.textContent).toBe('no :tada: here')
  })

  it('keeps italic styling around an emoji token', () => {
    const { container } = renderWithProvider(<Mrkdwn text="_italic :smile:_" users={{}} emoji={{}} />)
    expect(container.querySelector('em')).not.toBeNull()
  })

  it('renders a link inside bold as a bold anchor (not literal asterisks)', () => {
    const { container } = renderWithProvider(
      <Mrkdwn text="*<https://example.com|see this>*" users={{}} emoji={{}} />,
    )
    const strong = container.querySelector('strong')
    expect(strong).not.toBeNull()
    const a = strong?.querySelector('a')
    expect(a).not.toBeNull()
    expect(a?.getAttribute('href')).toBe('https://example.com')
    expect(a?.textContent).toBe('see this')
    // the literal asterisks must be gone
    expect(container.textContent).not.toContain('*')
  })

  it('renders a mention inside bold as a bold mention', () => {
    const { container } = renderWithProvider(<Mrkdwn text="*hi <@U1>*" users={users} emoji={{}} />)
    const strong = container.querySelector('strong')
    expect(strong).not.toBeNull()
    expect(strong?.textContent).toContain('@jane')
    expect(container.textContent).not.toContain('*')
  })

  it('renders a link inside italic and strike too', () => {
    const { container: ci } = renderWithProvider(
      <Mrkdwn text="_<https://example.com|x>_" users={{}} emoji={{}} />,
    )
    expect(ci.querySelector('em')?.querySelector('a')).not.toBeNull()
    const { container: cs } = renderWithProvider(
      <Mrkdwn text="~<https://example.com|y>~" users={{}} emoji={{}} />,
    )
    expect(cs.querySelector('del')?.querySelector('a')).not.toBeNull()
  })
})
