import { afterEach, describe, it, expect } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { BlockKitBlocks, hasRenderableBlocks } from './BlockKit'
import type { BlockKit, User } from '../../api/slackApi'

afterEach(cleanup)

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function renderWithProvider(ui: React.ReactElement) {
  return render(<MantineProvider>{ui}</MantineProvider>)
}

const users: Record<string, User> = { U1: { ID: 'U1', RealName: 'Jane Doe', DisplayName: 'jane', Avatar72: '' } }

function block(overrides: Partial<BlockKit>): BlockKit {
  return { Type: 'unsupported', Text: null, Elements: null, Accessory: null, ImageURL: '', AltText: '', RichText: null, ...overrides }
}

describe('hasRenderableBlocks', () => {
  it('is false for null and for all-unsupported', () => {
    expect(hasRenderableBlocks(null)).toBe(false)
    expect(hasRenderableBlocks([block({ Type: 'unsupported' })])).toBe(false)
  })
  it('is true when a content-bearing block is present', () => {
    expect(hasRenderableBlocks([block({ Type: 'section', Text: { Type: 'mrkdwn', Text: 'hi' } })])).toBe(true)
    expect(hasRenderableBlocks([block({ Type: 'image', ImageURL: 'https://x/a.png' })])).toBe(true)
    expect(
      hasRenderableBlocks([block({ Type: 'context', Elements: [{ Type: 'mrkdwn', ImageURL: '', AltText: '', Text: 'x' }] })]),
    ).toBe(true)
    expect(
      hasRenderableBlocks([
        block({ Type: 'rich_text', RichText: [{ Type: 'section', Elements: [], Style: '', Indent: 0, Items: null }] }),
      ]),
    ).toBe(true)
  })
  it('is false for a section/header with empty text and no accessory', () => {
    expect(hasRenderableBlocks([block({ Type: 'section', Text: { Type: 'mrkdwn', Text: '' } })])).toBe(false)
    expect(hasRenderableBlocks([block({ Type: 'section', Text: null })])).toBe(false)
    expect(hasRenderableBlocks([block({ Type: 'header', Text: { Type: 'plain_text', Text: '' } })])).toBe(false)
  })
  it('is true for a section with an image accessory even when text is empty', () => {
    expect(
      hasRenderableBlocks([
        block({ Type: 'section', Text: null, Accessory: { Type: 'image', ImageURL: 'https://x/t.png', AltText: '', Text: '' } }),
      ]),
    ).toBe(true)
  })
  it('is false for an empty context and an empty rich_text', () => {
    expect(hasRenderableBlocks([block({ Type: 'context', Elements: [] })])).toBe(false)
    expect(hasRenderableBlocks([block({ Type: 'context', Elements: null })])).toBe(false)
    expect(hasRenderableBlocks([block({ Type: 'rich_text', RichText: [] })])).toBe(false)
    expect(hasRenderableBlocks([block({ Type: 'rich_text', RichText: null })])).toBe(false)
  })
  it('treats a lone divider as non-content (a divider only separates real content)', () => {
    expect(hasRenderableBlocks([block({ Type: 'divider' })])).toBe(false)
    expect(hasRenderableBlocks([block({ Type: 'unsupported' }), block({ Type: 'divider' })])).toBe(false)
    // but a divider alongside real content is fine (the content is what counts)
    expect(
      hasRenderableBlocks([block({ Type: 'divider' }), block({ Type: 'section', Text: { Type: 'mrkdwn', Text: 'hi' } })]),
    ).toBe(true)
  })
})

describe('BlockKitBlocks', () => {
  it('section: renders mrkdwn text (mention resolved) and an accessory image', () => {
    const b = block({ Type: 'section', Text: { Type: 'mrkdwn', Text: 'hi <@U1> *bold*' },
      Accessory: { Type: 'image', ImageURL: 'https://cdn.test/x.png', AltText: 'thumb', Text: '' } })
    const { container } = renderWithProvider(<BlockKitBlocks blocks={[b]} users={users} emoji={{}} />)
    expect(container.textContent).toContain('@jane')
    expect(container.querySelector('strong')).not.toBeNull()
    expect(container.querySelector('img[src="https://cdn.test/x.png"]')).not.toBeNull()
  })

  it('section: accessory image hides on error', () => {
    const b = block({ Type: 'section', Text: { Type: 'mrkdwn', Text: 'hi' },
      Accessory: { Type: 'image', ImageURL: 'https://cdn.test/x.png', AltText: '', Text: '' } })
    const { container } = renderWithProvider(<BlockKitBlocks blocks={[b]} users={users} emoji={{}} />)
    const img = container.querySelector('img')!
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
  })

  it('context: renders an image and dimmed text', () => {
    const b = block({ Type: 'context', Elements: [
      { Type: 'image', ImageURL: 'https://cdn.test/i.png', AltText: 'a', Text: '' },
      { Type: 'mrkdwn', ImageURL: '', AltText: '', Text: 'updated' },
    ] })
    const { container } = renderWithProvider(<BlockKitBlocks blocks={[b]} users={users} emoji={{}} />)
    expect(container.querySelector('img[src="https://cdn.test/i.png"]')).not.toBeNull()
    expect(container.textContent).toContain('updated')
  })

  it('header renders bold text; divider renders an hr', () => {
    const { container } = renderWithProvider(
      <BlockKitBlocks blocks={[
        block({ Type: 'header', Text: { Type: 'plain_text', Text: 'Title' } }),
        block({ Type: 'divider' }),
      ]} users={users} emoji={{}} />,
    )
    expect(container.textContent).toContain('Title')
    expect(container.querySelector('hr')).not.toBeNull()
  })

  it('image block renders an img with alt', () => {
    const b = block({ Type: 'image', ImageURL: 'https://cdn.test/big.png', AltText: 'big' })
    const { container } = renderWithProvider(<BlockKitBlocks blocks={[b]} users={users} emoji={{}} />)
    const img = container.querySelector('img[src="https://cdn.test/big.png"]')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('alt')).toBe('big')
  })

  it('rich_text block delegates to RichText', () => {
    const b = block({ Type: 'rich_text', RichText: [
      { Type: 'section', Elements: [{ Type: 'text', Text: 'excerpt', URL: '', UserID: '', Name: '', Unicode: '', Style: { Bold: false, Italic: false, Code: false, Strike: false } }], Style: '', Indent: 0, Items: null },
    ] })
    const { container } = renderWithProvider(<BlockKitBlocks blocks={[b]} users={users} emoji={{}} />)
    expect(container.textContent).toContain('excerpt')
  })

  it('unsupported block renders nothing', () => {
    const { container } = renderWithProvider(<BlockKitBlocks blocks={[block({ Type: 'unsupported' })]} users={users} emoji={{}} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('hr')).toBeNull()
    // MantineProvider injects a <style> tag into the container, so check the
    // rendered Stack's own content rather than the whole container's textContent.
    expect(container.querySelector('.mantine-Stack-root')?.textContent?.trim()).toBe('')
  })
})
