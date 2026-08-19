import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { Message } from './Message'
import type { Block, Message as MessageData, User } from '../../api/slackApi'

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

function baseMessage(overrides: Partial<MessageData>): MessageData {
  return {
    TS: '1700000000.000001',
    UserID: 'U1',
    Text: 'fallback text',
    Blocks: null,
    Reactions: null,
    Edited: false,
    Files: null,
    Attachments: null,
    ...overrides,
  }
}

function sectionBlocks(text: string): Block[] {
  return [
    {
      Type: 'section',
      Elements: [
        {
          Type: 'text',
          Text: text,
          URL: '',
          UserID: '',
          Name: '',
          Unicode: '',
          Style: { Bold: false, Italic: false, Code: false, Strike: false },
        },
      ],
      Style: '',
      Indent: 0,
      Items: null,
    },
  ]
}

describe('Message', () => {
  it('renders the author name and falls back to Text when Blocks is empty', () => {
    const message = baseMessage({})
    const { container } = renderWithProvider(<Message message={message} users={users} emoji={{}} />)
    expect(container.textContent).toContain('jane')
    expect(container.textContent).toContain('fallback text')
  })

  it('renders message Blocks (a list) instead of the Text fallback when present', () => {
    const message = baseMessage({
      Blocks: [
        {
          Type: 'list',
          Elements: null,
          Style: 'bullet',
          Indent: 0,
          Items: [
            [
              {
                Type: 'text',
                Text: 'item one',
                URL: '',
                UserID: '',
                Name: '',
                Unicode: '',
                Style: { Bold: false, Italic: false, Code: false, Strike: false },
              },
            ],
          ],
        },
      ],
    })
    const { container } = renderWithProvider(<Message message={message} users={users} emoji={{}} />)
    expect(container.querySelector('ul li')?.textContent).toBe('item one')
    expect(container.textContent).not.toContain('fallback text')
  })

  it('renders a standard-emoji reaction as a glyph', () => {
    const message = baseMessage({
      Reactions: [{ Name: 'sweat_smile', Count: 2, UserIDs: ['U1'] }],
    })
    const { container } = renderWithProvider(<Message message={message} users={users} emoji={{}} />)
    expect(container.textContent).toContain('😅')
    expect(container.textContent).toContain('2')
    expect(container.textContent).not.toContain('sweat_smile')
  })

  it('renders a custom-emoji reaction as an image', () => {
    const emoji = { partyparrot: 'https://emoji.slack-edge.com/T0/partyparrot/abc.gif' }
    const message = baseMessage({
      Reactions: [{ Name: 'partyparrot', Count: 3, UserIDs: ['U1'] }],
    })
    const { container } = renderWithProvider(<Message message={message} users={users} emoji={emoji} />)
    const img = container.querySelector('img[alt=":partyparrot:"]')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toContain('/api/slack-emoji?url=')
  })

  it('renders a reaction the current user made as filled/blue', () => {
    const message = baseMessage({
      Reactions: [{ Name: 'sweat_smile', Count: 1, UserIDs: ['U1'] }],
    })
    const { container } = renderWithProvider(
      <Message message={message} users={users} emoji={{}} currentUserId="U1" />,
    )
    const badge = container.querySelector('[data-variant]')
    expect(badge?.getAttribute('data-variant')).toBe('filled')
  })

  it('renders a reaction the current user did not make as light/grey', () => {
    const message = baseMessage({
      Reactions: [{ Name: 'sweat_smile', Count: 1, UserIDs: ['U2'] }],
    })
    const { container } = renderWithProvider(
      <Message message={message} users={users} emoji={{}} currentUserId="U1" />,
    )
    const badge = container.querySelector('[data-variant]')
    expect(badge?.getAttribute('data-variant')).toBe('light')
  })

  it('does not crash when a reaction has null UserIDs', () => {
    const message = baseMessage({
      // The wire can send UserIDs: null (Go omits omitempty), so the render
      // must not throw on it.
      Reactions: [{ Name: 'sweat_smile', Count: 1, UserIDs: null }],
    })
    const { container } = renderWithProvider(
      <Message message={message} users={users} emoji={{}} currentUserId="U1" />,
    )
    const badge = container.querySelector('[data-variant]')
    // Unattributed → light/grey, and importantly no exception.
    expect(badge?.getAttribute('data-variant')).toBe('light')
  })

  it('formats the timestamp using the day-relative helper', () => {
    const message = baseMessage({ Blocks: sectionBlocks('hi') })
    const { container } = renderWithProvider(<Message message={message} users={users} emoji={{}} />)
    // Exact wording is covered by relativeTime.test.ts; just confirm the
    // time-of-day portion (h:mm AM/PM, no seconds) shows up somewhere.
    expect(container.textContent).toMatch(/\d{1,2}:\d{2} (AM|PM)/)
  })

  it('calls onMarkUnread with the message ts when the hover action is clicked', () => {
    const onMarkUnread = vi.fn()
    const message = baseMessage({ TS: '111.222' })
    const { getByLabelText } = renderWithProvider(
      <Message message={message} users={users} emoji={{}} onMarkUnread={onMarkUnread} />,
    )
    fireEvent.click(getByLabelText('Mark unread from here'))
    expect(onMarkUnread).toHaveBeenCalledWith('111.222')
  })
})
