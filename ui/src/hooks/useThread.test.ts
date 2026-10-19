import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useThread } from './useThread'

vi.mock('../api/slackApi', () => ({
  getThread: vi.fn(),
  eventsUrl: vi.fn(() => 'http://example.test/events'),
  ApiAuthError: class ApiAuthError extends Error {},
}))

const streams = vi.hoisted(() => ({ pause: true }))
vi.mock('../lib/backgroundStreams', async (orig) => ({
  ...(await orig<typeof import('../lib/backgroundStreams')>()),
  streamsPauseWhenHidden: () => streams.pause,
}))

import { getThread, type ThreadResponse } from '../api/slackApi'
import type { Tab } from '../state/tabs'

const mockGetThread = vi.mocked(getThread)

class MockEventSource {
  static all: MockEventSource[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  constructor(public url: string) {
    MockEventSource.all.push(this)
  }
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

const tab: Tab = { id: 't1', channel: 'C1', threadTs: '1.000', name: '', description: '' }
const thread = (latestReply: string) => ({ channel: 'C1', threadTs: '1.000', latestReply }) as ThreadResponse

afterEach(() => {
  streams.pause = true
  setVisibility('visible')
})

beforeEach(() => {
  mockGetThread.mockReset()
  MockEventSource.all = []
  vi.stubGlobal('EventSource', MockEventSource)
})

describe('useThread', () => {
  it('returns an idle result and opens no EventSource when tab is null', () => {
    const { result } = renderHook(() => useThread(null))

    expect(result.current.data).toBeNull()
    expect(result.current.status).toBe('loading')
    expect(result.current.authExpired).toBe(false)
    expect(result.current.lastUpdated).toBeNull()
    expect(mockGetThread).not.toHaveBeenCalled()
  })
  describe('over plain HTTP', () => {
    it('closes the stream while hidden, then refetches quietly and reopens it when shown', async () => {
      mockGetThread.mockResolvedValueOnce(thread('2.000'))
      const { result } = renderHook(() => useThread(tab))
      await waitFor(() => expect(MockEventSource.all).toHaveLength(1))

      act(() => setVisibility('hidden'))
      expect(MockEventSource.all[0].close).toHaveBeenCalled()

      mockGetThread.mockResolvedValueOnce(thread('3.000'))
      act(() => setVisibility('visible'))
      // The thread stays on screen while it catches up: no loading flash.
      expect(result.current.status).toBe('ready')
      expect(result.current.data?.latestReply).toBe('2.000')
      await waitFor(() => expect(result.current.data?.latestReply).toBe('3.000'))
      expect(MockEventSource.all).toHaveLength(2)
      expect(MockEventSource.all[1].close).not.toHaveBeenCalled()
    })

    it('opens no stream when the first load finishes while hidden', async () => {
      let resolve!: (t: ThreadResponse) => void
      mockGetThread.mockReturnValueOnce(new Promise((r) => (resolve = r)))
      const { result } = renderHook(() => useThread(tab))
      act(() => setVisibility('hidden'))
      await act(async () => resolve(thread('2.000')))
      expect(result.current.status).toBe('ready')
      expect(MockEventSource.all).toHaveLength(0)
    })
  })

  it('keeps the stream open while hidden when streams do not pause (HTTPS)', async () => {
    streams.pause = false
    mockGetThread.mockResolvedValueOnce(thread('2.000'))
    renderHook(() => useThread(tab))
    await waitFor(() => expect(MockEventSource.all).toHaveLength(1))
    act(() => setVisibility('hidden'))
    act(() => setVisibility('visible'))
    expect(MockEventSource.all[0].close).not.toHaveBeenCalled()
    expect(MockEventSource.all).toHaveLength(1)
    expect(mockGetThread).toHaveBeenCalledTimes(1)
  })
})
