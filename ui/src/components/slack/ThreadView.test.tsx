import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { $createTextNode, $getRoot, type ElementNode, type LexicalEditor } from 'lexical'
import { openInSlackUrl, ThreadView } from './ThreadView'
import type { UseThreadResult } from '../../hooks/useThread'
import type { Tab } from '../../state/tabs'

/** jsdom's contenteditable support is too thin for simulated typing to reach
 *  Lexical, so this drives the composer directly through its own API via
 *  ThreadView's test-only `onComposerEditorReady` escape hatch. */
function setEditorText(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot()
      const paragraph = root.getFirstChild() as ElementNode | null
      if (!paragraph) {
        return
      }
      for (const child of paragraph.getChildren()) {
        child.remove()
      }
      paragraph.append($createTextNode(text))
      paragraph.selectEnd()
    },
    { discrete: true },
  )
}

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

vi.mock('../../api/slackApi', async (orig) => ({
  ...(await orig<typeof import('../../api/slackApi')>()),
  postReply: vi.fn(),
  markRead: vi.fn(),
  markUnread: vi.fn(),
  getConfig: vi.fn().mockRejectedValue(new Error('no config in test')),
  avatarProxy: (url: string) => url,
  emojiProxy: (url: string) => url,
}))

import { markRead, markUnread, postReply } from '../../api/slackApi'

const mockPostReply = vi.mocked(postReply)
const mockMarkRead = vi.mocked(markRead)
const mockMarkUnread = vi.mocked(markUnread)

// RTL's queries default to document.body scope; without cleanup, renders
// from earlier tests in this file would bleed into later ones.
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// The view refreshes the app's unread surfaces through react-query after a
// read-state change, so it needs a client; tests that care pass their own.
function renderWithProvider(ui: React.ReactElement, qc = new QueryClient()) {
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MantineProvider>,
  )
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
    let editor: LexicalEditor | undefined
    const { getByRole, getByText, queryByLabelText } = renderWithProvider(
      <ThreadView
        tab={baseTab()}
        thread={baseThread()}
        onOpenThread={vi.fn()}
        onComposerEditorReady={(e) => {
          editor = e
        }}
      />,
    )

    const editorEl = getByRole('textbox')
    await waitFor(() => expect(editor).toBeDefined())
    act(() => {
      setEditorText(editor as LexicalEditor, 'hello there')
    })
    fireEvent.keyDown(editorEl, { key: 'Enter' })

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

describe('ThreadView refreshes unread surfaces after a read-state change', () => {
  const msg = (ts: string) =>
    ({ TS: ts, UserID: 'U2', Text: `m ${ts}`, Blocks: null, Reactions: null, Edited: false, Files: null, Attachments: null })

  function unreadThread(): UseThreadResult {
    const t = baseThread()
    t.data = { ...t.data!, messages: [msg('1700000000.000001'), msg('1700000001.000001')], unreadIndex: 1 }
    return t
  }

  // The server re-polls the thread before answering, so by the time the
  // write resolves the cached has_unread/last_read are fresh — the resource
  // cards, timeline dots and worktree badge only need to refetch.
  const surfaces = [['worktrees'], ['resources'], ['timeline']]

  it('invalidates worktrees, resources and timelines once mark-read lands', async () => {
    mockMarkRead.mockResolvedValue(undefined)
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const { getByRole } = renderWithProvider(
      <ThreadView tab={baseTab()} thread={unreadThread()} onOpenThread={vi.fn()} />, qc)
    fireEvent.click(getByRole('button', { name: 'Mark read' }))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(surfaces.length))
    for (const key of surfaces) expect(spy).toHaveBeenCalledWith({ queryKey: key })
  })

  it('invalidates them once mark-unread lands', async () => {
    mockMarkUnread.mockResolvedValue(undefined)
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const t = baseThread()
    t.data = { ...t.data!, messages: [msg('1700000000.000001'), msg('1700000001.000001')] }
    const { getAllByLabelText } = renderWithProvider(
      <ThreadView tab={baseTab()} thread={t} onOpenThread={vi.fn()} />, qc)
    fireEvent.click(getAllByLabelText('Mark unread from here')[0])
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(surfaces.length))
    for (const key of surfaces) expect(spy).toHaveBeenCalledWith({ queryKey: key })
  })

  it('does not invalidate when the write fails', async () => {
    mockMarkRead.mockRejectedValue(new Error('nope'))
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const { getByRole, findByText } = renderWithProvider(
      <ThreadView tab={baseTab()} thread={unreadThread()} onOpenThread={vi.fn()} />, qc)
    fireEvent.click(getByRole('button', { name: 'Mark read' }))
    await findByText('nope')
    expect(spy).not.toHaveBeenCalled()
  })
})
