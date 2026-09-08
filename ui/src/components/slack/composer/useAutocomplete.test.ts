import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAutocomplete } from './useAutocomplete'
import * as api from '../../../api/slackApi'

const ctx = {
  users: { U1: { ID: 'U1', Name: 'aroberts', RealName: 'Ada Roberts', DisplayName: 'ada', Avatar72: '' } },
  groups: {},
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useAutocomplete', () => {
  it('returns local candidates immediately, before any fetch resolves', () => {
    vi.spyOn(api, 'autocomplete').mockResolvedValue([])
    const { result } = renderHook(() =>
      useAutocomplete({ trigger: '@', query: 'ada', start: 0 }, 'C1', ctx),
    )
    expect(result.current.items.map((i) => i.id)).toContain('U1')
    expect(api.autocomplete).not.toHaveBeenCalled() // still inside the debounce
  })

  it('debounces, then merges remote results in', async () => {
    const spy = vi.spyOn(api, 'autocomplete').mockResolvedValue([
      { kind: 'user', id: 'U9', label: 'zoe', token: '<@U9>' },
    ])
    const { result } = renderHook(() =>
      useAutocomplete({ trigger: '@', query: 'ada', start: 0 }, 'C1', ctx),
    )
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(spy).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toContain('U9'))
    expect(result.current.items[0].id).toBe('U1') // local still ranks first
  })

  it('makes no request while the match is null', async () => {
    const spy = vi.spyOn(api, 'autocomplete').mockResolvedValue([])
    renderHook(() => useAutocomplete(null, 'C1', ctx))
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(spy).not.toHaveBeenCalled()
  })

  it('drops a stale response that resolves after a newer query', async () => {
    let resolveFirst: (v: api.AutocompleteItem[]) => void = () => {}
    const spy = vi
      .spyOn(api, 'autocomplete')
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce([{ kind: 'user', id: 'NEW', label: 'new', token: '<@NEW>' }])

    const { result, rerender } = renderHook(
      ({ q }) => useAutocomplete({ trigger: '@', query: q, start: 0 }, 'C1', ctx),
      { initialProps: { q: 'a' } },
    )
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    rerender({ q: 'ab' })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    // The first request now resolves — too late, and must be ignored.
    await act(async () => {
      resolveFirst([{ kind: 'user', id: 'STALE', label: 'stale', token: '<@STALE>' }])
    })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(result.current.items.map((i) => i.id)).not.toContain('STALE')
  })
})
