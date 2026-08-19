import { StrictMode, createElement } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useTabMetas } from './useTabMetas'
import type { Tab } from '../state/tabs'
import type { ThreadResponse } from '../api/slackApi'

vi.mock('../api/slackApi', () => ({
  getThread: vi.fn(),
}))

import { getThread } from '../api/slackApi'

const mockGetThread = vi.mocked(getThread)

function threadResponse(overrides: Partial<ThreadResponse>): ThreadResponse {
  return {
    channel: 'C1',
    channelName: 'general',
    threadTs: '1700000000.000001',
    lastRead: '',
    latestReply: '1700000005.000000',
    rootTs: '1700000000.000001',
    unreadIndex: -1,
    currentUserId: 'U1',
    messages: [
      {
        TS: '1700000000.000001',
        UserID: 'U1',
        Text: 'hi',
        Blocks: null,
        Reactions: null,
        Edited: false,
        Files: null,
        Attachments: null,
      },
    ],
    users: { U1: { ID: 'U1', RealName: 'Jane Doe', DisplayName: 'jane', Avatar72: '' } },
    emoji: {},
    ...overrides,
  }
}

function tab(overrides: Partial<Tab>): Tab {
  return {
    id: 'C1:1700000000.000001',
    channel: 'C1',
    threadTs: '1700000000.000001',
    name: 'C1 @ 1700000000.000001',
    description: '',
    ...overrides,
  }
}

beforeEach(() => {
  mockGetThread.mockReset()
})

describe('useTabMetas', () => {
  it('fetches and populates a meta for each open tab', async () => {
    mockGetThread.mockResolvedValue(threadResponse({}))
    const tabs = [tab({})]

    const { result } = renderHook(() => useTabMetas(tabs))

    await waitFor(() => {
      expect(result.current.get(tabs[0].id)?.status).toBe('ready')
    })

    const meta = result.current.get(tabs[0].id)
    expect(meta?.author).toBe('jane')
    expect(meta?.channelName).toBe('general')
    expect(meta?.hasUnread).toBe(false)
    expect(mockGetThread).toHaveBeenCalledWith('C1', '1700000000.000001')
  })

  it('marks a tab as error without affecting other tabs when its fetch fails', async () => {
    const okTab = tab({ id: 'C1:1', channel: 'C1', threadTs: '1' })
    const failTab = tab({ id: 'C2:2', channel: 'C2', threadTs: '2' })
    mockGetThread.mockImplementation((channel: string) => {
      if (channel === 'C2') {
        return Promise.reject(new Error('boom'))
      }
      return Promise.resolve(threadResponse({ channel: 'C1' }))
    })

    const { result } = renderHook(() => useTabMetas([okTab, failTab]))

    await waitFor(() => {
      expect(result.current.get(okTab.id)?.status).toBe('ready')
      expect(result.current.get(failTab.id)?.status).toBe('error')
    })
  })

  it('drops the meta for a tab once it is closed', async () => {
    mockGetThread.mockResolvedValue(threadResponse({}))
    const openTab = tab({})

    const { result, rerender } = renderHook(({ tabs }) => useTabMetas(tabs), {
      initialProps: { tabs: [openTab] },
    })

    await waitFor(() => {
      expect(result.current.get(openTab.id)?.status).toBe('ready')
    })

    rerender({ tabs: [] })

    await waitFor(() => {
      expect(result.current.has(openTab.id)).toBe(false)
    })
  })

  it('refetches all open tabs (including the active one) on the refresh interval', async () => {
    vi.useFakeTimers()
    try {
      mockGetThread.mockResolvedValue(threadResponse({}))
      const tabA = tab({ id: 'C1:1', channel: 'C1', threadTs: '1' })
      const tabB = tab({ id: 'C2:2', channel: 'C2', threadTs: '2' })

      const { result } = renderHook(() => useTabMetas([tabA, tabB]))

      // Both tabs are "new" on mount, so both get fetched once. Flush the
      // microtasks for that initial fetch — getThread's mocked promise
      // resolves on the microtask queue, then the setMetas callback needs
      // another tick to land in state.
      await vi.waitFor(() => {
        expect(result.current.get(tabA.id)?.status).toBe('ready')
        expect(result.current.get(tabB.id)?.status).toBe('ready')
      })
      expect(mockGetThread).toHaveBeenCalledTimes(2)

      mockGetThread.mockClear()

      // Advance past one refresh interval tick (30s).
      await vi.advanceTimersByTimeAsync(30_000)

      expect(mockGetThread).toHaveBeenCalledTimes(2)
      expect(mockGetThread).toHaveBeenCalledWith(tabA.channel, tabA.threadTs)
      expect(mockGetThread).toHaveBeenCalledWith(tabB.channel, tabB.threadTs)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not downgrade an existing ready meta to loading when a new tab appears', async () => {
    mockGetThread.mockResolvedValue(threadResponse({}))
    const existingTab = tab({ id: 'C1:1', channel: 'C1', threadTs: '1' })

    const { result, rerender } = renderHook(({ tabs }) => useTabMetas(tabs), {
      initialProps: { tabs: [existingTab] },
    })

    await waitFor(() => {
      expect(result.current.get(existingTab.id)?.status).toBe('ready')
    })

    const newTab = tab({ id: 'C2:2', channel: 'C2', threadTs: '2' })
    rerender({ tabs: [existingTab, newTab] })

    // The existing tab's ready meta must never blip back to 'loading' just
    // because a sibling tab was added.
    expect(result.current.get(existingTab.id)?.status).toBe('ready')

    await waitFor(() => {
      expect(result.current.get(newTab.id)?.status).toBe('ready')
    })
    expect(result.current.get(existingTab.id)?.status).toBe('ready')
  })

  it('recovers from Strict Mode double-invoking the fetch effect instead of getting stuck loading', async () => {
    // Reproduces the reload regression: Strict Mode mounts the effect,
    // cleans it up, then mounts it again — all before the first fetch's
    // promise resolves. A design that cancels the first run's setState (or
    // that marks a tab "already known" before its fetch lands) leaves the
    // tab stuck 'loading' forever, because the second run sees the tab as
    // already accounted for and never retries it. The fix must fetch any
    // tab lacking a 'ready' meta on every effect run, so the in-flight
    // first fetch is simply left to resolve into the 'ready' state.
    let resolveFirstFetch: (value: ReturnType<typeof threadResponse>) => void = () => {}
    const firstFetch = new Promise<ReturnType<typeof threadResponse>>((resolve) => {
      resolveFirstFetch = resolve
    })
    mockGetThread.mockReturnValueOnce(firstFetch)
    const onlyTab = tab({})

    const { result } = renderHook(() => useTabMetas([onlyTab]), {
      wrapper: ({ children }) => createElement(StrictMode, null, children),
    })

    // Strict Mode's mount -> cleanup -> mount has already happened
    // synchronously; the tab is seeded 'loading' and the still-pending
    // first fetch is the only in-flight request for it.
    expect(result.current.get(onlyTab.id)?.status).toBe('loading')

    resolveFirstFetch(threadResponse({}))

    await waitFor(() => {
      expect(result.current.get(onlyTab.id)?.status).toBe('ready')
    })
  })

  it('replaces an existing ready meta with fresh data on interval refetch rather than blanking it', async () => {
    vi.useFakeTimers()
    try {
      const initialResponse = threadResponse({ unreadIndex: -1 })
      const updatedResponse = threadResponse({ unreadIndex: 2, latestReply: '1700000010.000000' })
      mockGetThread.mockResolvedValueOnce(initialResponse).mockResolvedValueOnce(updatedResponse)
      const onlyTab = tab({})

      const { result } = renderHook(() => useTabMetas([onlyTab]))

      await vi.waitFor(() => {
        expect(result.current.get(onlyTab.id)?.status).toBe('ready')
        expect(result.current.get(onlyTab.id)?.hasUnread).toBe(false)
      })

      await vi.advanceTimersByTimeAsync(30_000)

      await vi.waitFor(() => {
        expect(result.current.get(onlyTab.id)?.hasUnread).toBe(true)
      })
      // Never observed as blanked back to 'loading' in between.
      expect(result.current.get(onlyTab.id)?.status).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })
})
