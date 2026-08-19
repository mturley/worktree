import { useEffect, useState } from 'react'
import { ApiAuthError, eventsUrl, getThread, type ThreadResponse } from '../api/slackApi'
import type { Tab } from '../state/tabs'

export type ThreadStatus = 'loading' | 'ready' | 'error'

export interface UseThreadResult {
  data: ThreadResponse | null
  status: ThreadStatus
  error?: string
  authExpired: boolean
  /** When the thread was last (re)loaded, via the initial fetch or an SSE
   * push. Null until the first successful load. */
  lastUpdated: Date | null
  refresh: () => void
  /**
   * Locally patches the current `data` without refetching or touching the
   * EventSource — for optimistic UI updates (e.g. mark read/unread) that
   * should apply instantly and get reconciled by the next SSE push. A
   * no-op if there's no data loaded yet.
   */
  applyLocal: (patch: (data: ThreadResponse) => ThreadResponse) => void
}

/**
 * Loads a thread for `tab` and keeps it live via SSE.
 *
 * On mount (and whenever tab.channel/tab.threadTs change), fetches the
 * initial ThreadResponse, then opens an EventSource that replaces the
 * state with each enriched ThreadResponse pushed by the server. The
 * EventSource is closed on unmount or when the tab changes.
 *
 * `tab` may be null (e.g. no tab is active yet) — in that case the hook
 * short-circuits: it opens no EventSource, issues no fetch, and returns an
 * idle "loading" result. This lets callers keep hook order stable by
 * calling useThread unconditionally instead of skipping it when there's no
 * active tab.
 */
export function useThread(tab: Tab | null): UseThreadResult {
  const [data, setData] = useState<ThreadResponse | null>(null)
  const [status, setStatus] = useState<ThreadStatus>('loading')
  const [error, setError] = useState<string | undefined>(undefined)
  const [authExpired, setAuthExpired] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    let source: EventSource | null = null

    setStatus('loading')
    setError(undefined)
    setAuthExpired(false)
    setData(null)
    setLastUpdated(null)

    if (!tab) {
      return
    }

    async function load() {
      if (!tab) {
        return
      }
      try {
        const initial = await getThread(tab.channel, tab.threadTs)
        if (cancelled) {
          return
        }
        setData(initial)
        setStatus('ready')
        setLastUpdated(new Date())

        source = new EventSource(eventsUrl(tab.channel, tab.threadTs))
        source.onmessage = (event) => {
          if (cancelled) {
            return
          }
          try {
            const parsed = JSON.parse(event.data) as ThreadResponse
            setData(parsed)
            setStatus('ready')
            setLastUpdated(new Date())
          } catch {
            // Ignore malformed SSE payloads; keep the last good state.
          }
        }
        source.onerror = () => {
          // EventSource auto-reconnects; don't surface transient network
          // blips as a hard error state.
        }
      } catch (err) {
        if (cancelled) {
          return
        }
        if (err instanceof ApiAuthError) {
          setAuthExpired(true)
          setError(err.message)
        } else {
          setError(err instanceof Error ? err.message : String(err))
        }
        setStatus('error')
      }
    }

    void load()

    return () => {
      cancelled = true
      source?.close()
    }
  }, [tab?.channel, tab?.threadTs, refreshNonce])

  function refresh() {
    setRefreshNonce((n) => n + 1)
  }

  function applyLocal(patch: (data: ThreadResponse) => ThreadResponse) {
    setData((prev) => (prev ? patch(prev) : prev))
    setLastUpdated(new Date())
  }

  return { data, status, error, authExpired, lastUpdated, refresh, applyLocal }
}
