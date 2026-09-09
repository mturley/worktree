import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAutocomplete, fetchAutocompleteResult } from './useAutocomplete'
import * as api from '../../../api/slackApi'

const ctx = {
  users: { U1: { ID: 'U1', Name: 'aroberts', RealName: 'Ada Roberts', DisplayName: 'ada', Avatar72: '' } },
  groups: {},
}

beforeEach(() => {
  vi.useFakeTimers()
  // @testing-library/dom's waitFor() only auto-advances fake timers when it
  // detects Jest's fake-timer clock (a global `jest` plus a `.clock`
  // property Jest's modern timers attach to `setTimeout`). Vitest's
  // `vi.useFakeTimers()` attaches the same `.clock` property but exposes no
  // `jest` global, so without this alias `waitFor` polls via a `setTimeout`
  // that fake timers have mocked — it never fires, and the test hangs.
  // Scoped to this file (not test-setup.ts) so it can't silently change
  // waitFor/findBy* behaviour for other tests that add fake timers later.
  vi.stubGlobal('jest', vi)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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

  it("does not keep a previous query's results while a newer query is still in flight", async () => {
    // C1: the menu must never list — let alone highlight — a candidate that
    // only matched an earlier query. Enter on such a row posts a mention of
    // the wrong person. Unlike the stale-response test above, the NEWER
    // request here never resolves: this is plain typing rhythm, not a race.
    const spy = vi
      .spyOn(api, 'autocomplete')
      .mockResolvedValueOnce([{ kind: 'user', id: 'DAN', label: 'Dan Smith', token: '<@DAN>' }])
      .mockImplementationOnce(() => new Promise(() => {})) // never resolves

    const { result, rerender } = renderHook(
      ({ q }) => useAutocomplete({ trigger: '@', query: q, start: 0 }, 'C1', ctx),
      { initialProps: { q: 'dan' } },
    )
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toContain('DAN'))

    // Keep typing. The debounce fires, the second request goes out and stays
    // in flight; Dan Smith must be gone from the menu the whole time.
    rerender({ q: 'daniel.roberts' })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(result.current.items.map((i) => i.id)).not.toContain('DAN')
  })

  it('unmounting while a request is in flight does not throw and does not change items afterward', async () => {
    let resolveRequest: (v: api.AutocompleteItem[]) => void = () => {}
    vi.spyOn(api, 'autocomplete').mockImplementation(
      () => new Promise((r) => (resolveRequest = r)),
    )
    const { unmount } = renderHook(() =>
      useAutocomplete({ trigger: '@', query: 'ada', start: 0 }, 'C1', ctx),
    )
    // Fire the debounce timer so the fetch is in flight, then unmount before
    // it resolves — this is the sequence seq.current alone cannot catch.
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(() => unmount()).not.toThrow()
    // The in-flight request now resolves, after unmount. This must not
    // throw either — the assertion that actually proves the guard fired is
    // the direct unit test on fetchAutocompleteResult below, since React 19
    // silently no-ops a post-unmount setState with no observable signal
    // (no warning, no error) for a black-box test to catch.
    await act(async () => {
      resolveRequest([{ kind: 'user', id: 'LATE', label: 'late', token: '<@LATE>' }])
    })
  })
})

describe('useAutocomplete degraded reporting', () => {
  it('does not claim the workspace search is unavailable for a query with no matches', async () => {
    // "@zzzq" with Slack perfectly healthy: an empty 200. Reporting that as
    // degraded sends the user off to re-run `worktree setup` for nothing.
    vi.spyOn(api, 'autocomplete').mockResolvedValue([])
    const { result } = renderHook(() =>
      useAutocomplete({ trigger: '@', query: 'zzzq', start: 0 }, 'C1', ctx),
    )
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    await waitFor(() => expect(api.autocomplete).toHaveBeenCalled())
    expect(result.current.degraded).toBe(false)
  })

  it('reports degraded when the lookup actually failed', async () => {
    vi.spyOn(api, 'autocomplete').mockResolvedValue(null)
    const { result } = renderHook(() =>
      useAutocomplete({ trigger: '@', query: 'zzzq', start: 0 }, 'C1', ctx),
    )
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    await waitFor(() => expect(result.current.degraded).toBe(true))
  })
})

describe('fetchAutocompleteResult', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not call onResult when isStale() reports true before the request resolves', async () => {
    let resolveRequest: (v: api.AutocompleteItem[]) => void = () => {}
    vi.spyOn(api, 'autocomplete').mockImplementation(
      () => new Promise((r) => (resolveRequest = r)),
    )
    const onResult = vi.fn()
    let stale = false
    const promise = fetchAutocompleteResult(
      '@',
      'ada',
      'C1',
      new AbortController().signal,
      () => stale,
      onResult,
    )
    // Simulates unmount happening while the request is still in flight — the
    // exact sequence the effect's cleanup flag is meant to guard against.
    stale = true
    resolveRequest([{ kind: 'user', id: 'LATE', label: 'late', token: '<@LATE>' }])
    await promise
    expect(onResult).not.toHaveBeenCalled()
  })

  it('calls onResult when isStale() stays false', async () => {
    const items: api.AutocompleteItem[] = [{ kind: 'user', id: 'U1', label: 'ada', token: '<@U1>' }]
    vi.spyOn(api, 'autocomplete').mockResolvedValue(items)
    const onResult = vi.fn()
    await fetchAutocompleteResult('@', 'ada', 'C1', new AbortController().signal, () => false, onResult)
    expect(onResult).toHaveBeenCalledWith(items)
  })
})
