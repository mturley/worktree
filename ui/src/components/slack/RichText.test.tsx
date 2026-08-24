import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { RichText } from './RichText'
import type { Block, Element, User } from '../../api/slackApi'

const users: Record<string, User> = {
  U123: { ID: 'U123', RealName: 'Jane Doe', DisplayName: 'jane', Avatar72: '' },
}

const emoji: Record<string, string> = {
  partyparrot: 'https://emoji.slack-edge.com/T0/partyparrot/abc.gif',
}

function textEl(text: string): Element {
  return {
    Type: 'text',
    Text: text,
    URL: '',
    UserID: '',
    Name: '',
    Unicode: '',
    Style: { Bold: false, Italic: false, Code: false, Strike: false },
  }
}

function userEl(userId: string): Element {
  return { ...textEl(''), Type: 'user', UserID: userId }
}

function emojiEl(name: string, unicode = ''): Element {
  return { ...textEl(''), Type: 'emoji', Name: name, Unicode: unicode }
}

function linkEl(text: string, url: string): Element {
  return { ...textEl(text), Type: 'link', URL: url }
}

/** Wraps a leaf-element array in a single "section" block, the shape most
 * existing element-rendering assertions exercise. */
function sectionBlock(elements: Element[]): Block {
  return { Type: 'section', Elements: elements, Style: '', Indent: 0, Items: null }
}

describe('RichText', () => {
  it('renders a mixed element array: text, resolved user mention, custom emoji, unicode emoji, link', () => {
    const elements: Element[] = [
      textEl('hello '),
      userEl('U123'),
      textEl(' check out '),
      emojiEl('partyparrot'),
      textEl(' and '),
      // Slack's `unicode` field is a hyphen-separated hex codepoint
      // sequence, not the literal glyph — "1f604" is 😄.
      emojiEl('smile', '1f604'),
      textEl(' '),
      linkEl('this link', 'https://example.com'),
    ]

    const { container } = render(
      <RichText blocks={[sectionBlock(elements)]} users={users} emoji={emoji} />,
    )

    // Resolved user mention
    expect(container.textContent).toContain('@jane')
    // Custom emoji rendered as an img via the emoji proxy
    const img = container.querySelector('img[alt=":partyparrot:"]')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toContain('/api/slack-emoji?url=')
    // Unicode emoji rendered as the literal character
    expect(container.textContent).toContain('😄')
    // Link rendered as anchor with target=_blank and rel=noreferrer
    const link = container.querySelector('a[href="https://example.com"]')
    expect(link).not.toBeNull()
    expect(link?.textContent).toBe('this link')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noreferrer')
    // Plain text segments present
    expect(container.textContent).toContain('hello')
    expect(container.textContent).toContain('check out')
  })

  it('falls back to @UserID when user is not in the users map', () => {
    const { container } = render(
      <RichText blocks={[sectionBlock([userEl('U999')])]} users={{}} emoji={{}} />,
    )
    expect(container.textContent).toContain('@U999')
  })

  it('falls back to :name: text when custom emoji is not in the emoji map', () => {
    const { container } = render(
      <RichText blocks={[sectionBlock([emojiEl('missingemoji')])]} users={{}} emoji={{}} />,
    )
    expect(container.textContent).toContain(':missingemoji:')
  })

  it('renders bold/italic/code/strike text styles', () => {
    const elements: Element[] = [
      { ...textEl('bold'), Style: { Bold: true, Italic: false, Code: false, Strike: false } },
      { ...textEl('italic'), Style: { Bold: false, Italic: true, Code: false, Strike: false } },
      { ...textEl('code'), Style: { Bold: false, Italic: false, Code: true, Strike: false } },
      { ...textEl('strike'), Style: { Bold: false, Italic: false, Code: false, Strike: true } },
    ]
    const { container } = render(<RichText blocks={[sectionBlock(elements)]} users={{}} emoji={{}} />)
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(container.querySelector('em')?.textContent).toBe('italic')
    expect(container.querySelector('code')?.textContent).toBe('code')
    expect(container.querySelector('del')?.textContent).toBe('strike')
  })

  it('combines bold and strike on the same text element', () => {
    const el: Element = {
      ...textEl('important'),
      Style: { Bold: true, Italic: false, Code: false, Strike: true },
    }
    const { container } = render(<RichText blocks={[sectionBlock([el])]} users={{}} emoji={{}} />)
    const del = container.querySelector('del')
    expect(del).not.toBeNull()
    expect(del?.querySelector('strong')?.textContent).toBe('important')
  })

  it('renders a usergroup element as readable text', () => {
    const el: Element = { ...textEl(''), Type: 'usergroup', Name: 'engineering' }
    const { container } = render(<RichText blocks={[sectionBlock([el])]} users={{}} emoji={{}} />)
    expect(container.textContent).toContain('@engineering')
  })

  it('renders broadcast elements (here/channel) as readable text', () => {
    const hereEl: Element = { ...textEl(''), Type: 'broadcast', Name: 'here' }
    const channelEl: Element = { ...hereEl, Name: 'channel' }

    const { container: hereContainer } = render(
      <RichText blocks={[sectionBlock([hereEl])]} users={{}} emoji={{}} />,
    )
    expect(hereContainer.textContent).toContain('@here')

    const { container: channelContainer } = render(
      <RichText blocks={[sectionBlock([channelEl])]} users={{}} emoji={{}} />,
    )
    expect(channelContainer.textContent).toContain('@channel')
  })

  it('converts a single-codepoint unicode hex string to the emoji glyph, not the raw hex text', () => {
    const { container } = render(
      <RichText blocks={[sectionBlock([emojiEl('sweat_smile', '1f605')])]} users={{}} emoji={{}} />,
    )
    expect(container.textContent).toBe('😅')
    expect(container.textContent).not.toContain('1f605')
  })

  it('converts a multi-codepoint unicode hex sequence to the combined glyph', () => {
    // "man technologist" ZWJ sequence: man + ZWJ + laptop
    const { container } = render(
      <RichText
        blocks={[sectionBlock([emojiEl('technologist', '1f468-200d-1f4bb')])]}
        users={{}}
        emoji={{}}
      />,
    )
    expect(container.textContent).toBe('👨‍💻')
  })

  it('resolves a standard emoji by name via the emoji library when no unicode is given', () => {
    const { container } = render(
      <RichText blocks={[sectionBlock([emojiEl('laughing')])]} users={{}} emoji={{}} />,
    )
    expect(container.textContent).toBe('😆')
  })

  it('prefers a custom workspace emoji image over the standard-library glyph for the same name', () => {
    const { container } = render(
      <RichText blocks={[sectionBlock([emojiEl('partyparrot')])]} users={{}} emoji={emoji} />,
    )
    const img = container.querySelector('img[alt=":partyparrot:"]')
    expect(img).not.toBeNull()
  })

  it('falls back to :name: text for a malformed unicode value that is not in the custom map or library', () => {
    const { container } = render(
      <RichText
        blocks={[sectionBlock([emojiEl('not_a_real_emoji_name', 'not-hex')])]}
        users={{}}
        emoji={{}}
      />,
    )
    expect(container.textContent).toBe(':not_a_real_emoji_name:')
  })

  it('returns null for an empty/missing blocks array', () => {
    const { container: c1 } = render(<RichText blocks={null} users={{}} emoji={{}} />)
    expect(c1.textContent).toBe('')
    const { container: c2 } = render(<RichText blocks={[]} users={{}} emoji={{}} />)
    expect(c2.textContent).toBe('')
  })

  it('renders a bullet list block as <ul>/<li> with item text', () => {
    const block: Block = {
      Type: 'list',
      Elements: null,
      Style: 'bullet',
      Indent: 0,
      Items: [[textEl('first item')], [textEl('second item')]],
    }
    const { container } = render(<RichText blocks={[block]} users={{}} emoji={{}} />)
    const ul = container.querySelector('ul')
    expect(ul).not.toBeNull()
    const items = container.querySelectorAll('li')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toBe('first item')
    expect(items[1].textContent).toBe('second item')
  })

  it('renders an ordered list block as <ol>', () => {
    const block: Block = {
      Type: 'list',
      Elements: null,
      Style: 'ordered',
      Indent: 0,
      Items: [[textEl('one')]],
    }
    const { container } = render(<RichText blocks={[block]} users={{}} emoji={{}} />)
    expect(container.querySelector('ol')).not.toBeNull()
    expect(container.querySelector('ul')).toBeNull()
  })

  it('resolves a mention and an emoji inside a list item', () => {
    const block: Block = {
      Type: 'list',
      Elements: null,
      Style: 'bullet',
      Indent: 0,
      Items: [[userEl('U123'), textEl(' likes '), emojiEl('partyparrot')]],
    }
    const { container } = render(<RichText blocks={[block]} users={users} emoji={emoji} />)
    expect(container.textContent).toContain('@jane')
    expect(container.querySelector('li img[alt=":partyparrot:"]')).not.toBeNull()
  })

  it('renders a quote block as a blockquote', () => {
    const block: Block = { Type: 'quote', Elements: [textEl('quoted text')], Style: '', Indent: 0, Items: null }
    const { container } = render(<RichText blocks={[block]} users={{}} emoji={{}} />)
    const bq = container.querySelector('blockquote')
    expect(bq).not.toBeNull()
    expect(bq?.textContent).toBe('quoted text')
  })

  it('renders a preformatted block as a <pre> code block', () => {
    const block: Block = {
      Type: 'preformatted',
      Elements: [textEl('const x = 1;')],
      Style: '',
      Indent: 0,
      Items: null,
    }
    const { container } = render(<RichText blocks={[block]} users={{}} emoji={{}} />)
    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toBe('const x = 1;')
  })
})

describe('RichText usergroup and broadcast elements', () => {
  it('renders @channel and @everyone distinctly, not all as @here', () => {
    // Slack sends the kind in "range"; reading Name (always empty for these)
    // made every broadcast render as @here.
    const chan = render(
      <RichText blocks={[sectionBlock([{ ...textEl(''), Type: 'broadcast', Range: 'channel' }])]} users={{}} emoji={{}} />)
    expect(chan.container.textContent).toContain('@channel')

    const everyone = render(
      <RichText blocks={[sectionBlock([{ ...textEl(''), Type: 'broadcast', Range: 'everyone' }])]} users={{}} emoji={{}} />)
    expect(everyone.container.textContent).toContain('@everyone')
  })

  it('falls back to the subteam id for an unresolved group, not a generic word', () => {
    const { container } = render(
      <RichText blocks={[sectionBlock([{ ...textEl(''), Type: 'usergroup', UserGroupID: 'S42' }])]} users={{}} emoji={{}} />)
    expect(container.textContent).toContain('@S42')
    expect(container.textContent).not.toContain('usergroup')
  })
})
