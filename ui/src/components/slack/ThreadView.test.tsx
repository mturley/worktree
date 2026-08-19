import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { openInSlackUrl, ThreadView } from './ThreadView'
import type { UseThreadResult } from '../../hooks/useThread'
import type { Tab } from '../../state/tabs'

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

vi.mock('../../api/slackApi', () => ({
  postReply: vi.fn(),
  markRead: vi.fn(),
  markUnread: vi.fn(),
  getConfig: vi.fn().mockRejectedValue(new Error('no config in test')),
  avatarProxy: (url: string) => url,
  emojiProxy: (url: string) => url,
}))

import { postReply } from '../../api/slackApi'

const mockPostReply = vi.mocked(postReply)

// RTL's queries default to document.body scope; without cleanup, renders
// from earlier tests in this file would bleed into later ones.
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderWithProvider(ui: React.ReactElement) {
  return render(<MantineProvider>{ui}</MantineProvider>)
}

function baseTab(): Tab {
  return { id: 't1', channel: 'C1', threadTs: '1700000000.000001', name: 'thread', description: '' }
}

function baseThread(): UseThreadResult {
  return {
    data: {
      channel: 'C1',
      channelName: 'general',
      threadTs: '1700000000.000001',
      lastRead: '',
      latestReply: '',
      rootTs: '1700000000.000001',
      unreadIndex: -1,
      currentUserId: 'U1',
      messages: [],
      users: {},
      emoji: {},
    },
    status: 'ready',
    error: undefined,
    authExpired: false,
    lastUpdated: null,
    refresh: vi.fn(),
    applyLocal: vi.fn(),
  }
}

describe('ThreadView pending replies on an empty thread', () => {
  it('shows a failed pending reply with Retry/Dismiss even when data.messages is empty', async () => {
    mockPostReply.mockRejectedValue(new Error('blocked: not on allowlist'))
    const { getByRole, getByText, queryByLabelText } = renderWithProvider(
      <ThreadView tab={baseTab()} thread={baseThread()} onUpdateTab={vi.fn()} onOpenThread={vi.fn()} />,
    )

    const textarea = getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'hello there' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(getByText('blocked: not on allowlist')).toBeTruthy()
    })
    expect(getByRole('button', { name: /retry/i })).toBeTruthy()
    expect(getByRole('button', { name: /dismiss/i })).toBeTruthy()
    // Sanity: this is exercising the zero-message branch, not the
    // populated-thread branch.
    expect(queryByLabelText('Mark unread from here')).toBeNull()
  })
})

describe('openInSlackUrl', () => {
  it('builds a URL from a plain workspace host without appending .slack.com', () => {
    const url = openInSlackUrl('C123', '1700000000.000001', '1700000000.000002', 'myteam.slack.com')

    expect(url).toBe(
      'https://myteam.slack.com/archives/C123/p1700000000000002?thread_ts=1700000000.000001&cid=C123',
    )
    expect(url).not.toContain('.slack.com.slack.com')
  })

  it('builds a URL from an enterprise workspace host without appending .slack.com', () => {
    const url = openInSlackUrl(
      'C456',
      '1700000000.000003',
      '1700000000.000004',
      'redhat.enterprise.slack.com',
    )

    expect(url).toBe(
      'https://redhat.enterprise.slack.com/archives/C456/p1700000000000004?thread_ts=1700000000.000003&cid=C456',
    )
    expect(url).not.toContain('.slack.com.slack.com')
  })
})
