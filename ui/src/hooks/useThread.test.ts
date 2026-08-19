import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useThread } from './useThread'

vi.mock('../api/slackApi', () => ({
  getThread: vi.fn(),
  eventsUrl: vi.fn(() => 'http://example.test/events'),
  ApiAuthError: class ApiAuthError extends Error {},
}))

import { getThread } from '../api/slackApi'

const mockGetThread = vi.mocked(getThread)

class MockEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  constructor(public url: string) {}
}

beforeEach(() => {
  mockGetThread.mockReset()
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
})
