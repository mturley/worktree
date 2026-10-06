import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
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

describe('ThreadView initial scroll position', () => {
  const msg = (ts: string) =>
    ({ TS: ts, UserID: 'U2', Text: `m ${ts}`, Blocks: null, Reactions: null, Edited: false, Files: null, Attachments: null })

  // The worktree page scrolls the DOCUMENT, so the view positions itself with
  // scrollIntoView (which moves whatever actually scrolls) rather than by
  // setting a scrollTop. jsdom has no scrollIntoView, so record the calls.
  let scrolled: { el: Element; opts: ScrollIntoViewOptions | boolean | undefined }[] = []
  const original = Element.prototype.scrollIntoView
  beforeEach(() => {
    scrolled = []
    Element.prototype.scrollIntoView = function (this: Element, opts?: ScrollIntoViewOptions | boolean) {
      scrolled.push({ el: this, opts })
    }
  })
  afterEach(() => {
    Element.prototype.scrollIntoView = original
  })

  function wrap(tab: Tab, thread: UseThreadResult, qc: QueryClient) {
    return (
      <MantineProvider>
        <QueryClientProvider client={qc}>
          <ThreadView tab={tab} thread={thread} onOpenThread={vi.fn()} />
        </QueryClientProvider>
      </MantineProvider>
    )
  }

  function readThread(): UseThreadResult {
    const t = baseThread()
    t.data = { ...t.data!, messages: [msg('1700000000.000001'), msg('1700000001.000001')] }
    return t
  }

  it('opens at the end of the thread when there are no unreads', () => {
    const { container } = render(wrap(baseTab(), readThread(), new QueryClient()))
    expect(scrolled).toHaveLength(1)
    expect(scrolled[0].opts).toEqual({ block: 'end' })
    // The end marker is the thread's last element, below the composer.
    expect(scrolled[0].el.nextElementSibling).toBeNull()
    expect(container.contains(scrolled[0].el)).toBe(true)
  })

  it('aligns the unread divider a quarter of the way down the window', () => {
    const t = baseThread()
    t.data = {
      ...t.data!,
      messages: [msg('1700000000.000001'), msg('1700000001.000001'), msg('1700000002.000001')],
      unreadIndex: 1,
    }
    const { getByText } = render(wrap(baseTab(), t, new QueryClient()))
    expect(scrolled).toHaveLength(1)
    expect(scrolled[0].opts).toEqual({ block: 'start' })
    // The divider alone, not its whole row, so it is the divider that lands
    // at the target line rather than the top of a tall first unread message.
    expect(scrolled[0].el.contains(getByText('New'))).toBe(true)
    expect(scrolled[0].el.textContent).toBe('New')
    // scrollIntoView honours scroll-margin: a top margin of a quarter of the
    // window stops the divider that far down instead of at the very top.
    expect((scrolled[0].el as HTMLElement).style.scrollMarginTop).toBe(`${window.innerHeight / 4}px`)
  })

  it('measures that quarter below a sticky header covering the top', () => {
    const t = baseThread()
    t.data = { ...t.data!, messages: [msg('1700000000.000001'), msg('1700000001.000001')], unreadIndex: 1 }
    render(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <ThreadView tab={baseTab()} thread={t} onOpenThread={vi.fn()} topInset={240} />
        </QueryClientProvider>
      </MantineProvider>,
    )
    const visible = window.innerHeight - 240
    expect((scrolled[0].el as HTMLElement).style.scrollMarginTop).toBe(`${240 + visible / 4}px`)
  })

  it('waits for the messages to load', () => {
    const qc = new QueryClient()
    const loading = { ...baseThread(), data: null, status: 'loading' as const }
    const { rerender } = render(wrap(baseTab(), loading, qc))
    expect(scrolled).toHaveLength(0)
    rerender(wrap(baseTab(), readThread(), qc))
    expect(scrolled).toHaveLength(1)
  })

  it('positions once per thread, not on every live update', () => {
    const qc = new QueryClient()
    const t = readThread()
    t.data = { ...t.data!, unreadIndex: 1 }
    const { rerender } = render(wrap(baseTab(), t, qc))
    const updated = { ...t, data: { ...t.data!, messages: [...t.data!.messages, msg('1700000002.000001')] } }
    rerender(wrap(baseTab(), updated, qc))
    // Following new messages to the end is a separate behaviour (see below);
    // the jump to the unread divider must not happen again.
    expect(scrolled.filter((s) => (s.opts as ScrollIntoViewOptions).block === 'start')).toHaveLength(1)
  })

  it('positions again when a different thread is selected', () => {
    const qc = new QueryClient()
    const t = readThread()
    const { rerender } = render(wrap(baseTab(), t, qc))
    rerender(wrap({ ...baseTab(), id: 't2', threadTs: '1700000099.000001' }, t, qc))
    expect(scrolled).toHaveLength(2)
  })
})

describe('ThreadView following the end of the thread', () => {
  const msg = (ts: string) =>
    ({ TS: ts, UserID: 'U2', Text: `m ${ts}`, Blocks: null, Reactions: null, Edited: false, Files: null, Attachments: null })

  // The page scrolls, not the list, so "at the end" is whether the end of the
  // message list is on screen: an IntersectionObserver, which jsdom lacks.
  let observed: { cb: IntersectionObserverCallback; el: Element }[] = []
  let scrolled: { el: Element; opts: ScrollIntoViewOptions | boolean | undefined }[] = []
  const originalScroll = Element.prototype.scrollIntoView
  const originalIO = window.IntersectionObserver
  beforeEach(() => {
    observed = []
    scrolled = []
    Element.prototype.scrollIntoView = function (this: Element, opts?: ScrollIntoViewOptions | boolean) {
      scrolled.push({ el: this, opts })
    }
    window.IntersectionObserver = class {
      cb: IntersectionObserverCallback
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb
      }
      observe(el: Element) {
        observed.push({ cb: this.cb, el })
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return []
      }
    } as unknown as typeof IntersectionObserver
  })
  afterEach(() => {
    Element.prototype.scrollIntoView = originalScroll
    window.IntersectionObserver = originalIO
  })

  function setListEndVisible(visible: boolean) {
    act(() => {
      for (const o of observed) {
        o.cb([{ isIntersecting: visible, target: o.el } as IntersectionObserverEntry], {} as IntersectionObserver)
      }
    })
  }

  function wrap(thread: UseThreadResult, qc: QueryClient) {
    return (
      <MantineProvider>
        <QueryClientProvider client={qc}>
          <ThreadView tab={baseTab()} thread={thread} onOpenThread={vi.fn()} />
        </QueryClientProvider>
      </MantineProvider>
    )
  }

  function thread(count: number, unreadIndex = -1): UseThreadResult {
    const t = baseThread()
    t.data = {
      ...t.data!,
      messages: Array.from({ length: count }, (_, i) => msg(`170000000${i}.000001`)),
      unreadIndex,
    }
    return t
  }

  it('offers a jump to the end only when the end is off screen', () => {
    const { queryByRole } = render(wrap(thread(2), new QueryClient()))
    setListEndVisible(true)
    expect(queryByRole('button', { name: 'More messages ↓' })).toBeNull()
    setListEndVisible(false)
    expect(queryByRole('button', { name: 'More messages ↓' })).not.toBeNull()
  })

  it('calls it "New messages" when there are unreads', () => {
    const { getByRole } = render(wrap(thread(2, 1), new QueryClient()))
    setListEndVisible(false)
    expect(getByRole('button', { name: 'New messages ↓' })).toBeTruthy()
  })

  it('jumps to the end of the thread when clicked', () => {
    const { getByRole } = render(wrap(thread(2), new QueryClient()))
    setListEndVisible(false)
    scrolled = []
    fireEvent.click(getByRole('button', { name: 'More messages ↓' }))
    expect(scrolled).toHaveLength(1)
    expect(scrolled[0].opts).toEqual({ block: 'end' })
    expect(scrolled[0].el.nextElementSibling).toBeNull()
  })

  it('follows new messages when the reader is at the end', () => {
    const qc = new QueryClient()
    const { rerender } = render(wrap(thread(2), qc))
    setListEndVisible(true)
    scrolled = []
    rerender(wrap(thread(3), qc))
    expect(scrolled).toHaveLength(1)
    expect(scrolled[0].opts).toEqual({ block: 'end' })
  })

  it('leaves a reader who has scrolled up where they are', () => {
    const qc = new QueryClient()
    const { rerender } = render(wrap(thread(2), qc))
    setListEndVisible(false)
    scrolled = []
    rerender(wrap(thread(3), qc))
    expect(scrolled).toHaveLength(0)
  })

  it('does not let following override the initial unread position', () => {
    render(wrap(thread(3, 1), new QueryClient()))
    expect(scrolled).toHaveLength(1)
    expect(scrolled[0].opts).toEqual({ block: 'start' })
  })
})
