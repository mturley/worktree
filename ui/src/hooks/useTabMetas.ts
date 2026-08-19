import { useEffect, useRef, useState } from 'react'
import { getThread } from '../api/slackApi'
import { deriveThreadMeta } from '../lib/deriveThreadMeta'
import type { Tab } from '../state/tabs'

export type TabMetaStatus = 'loading' | 'ready' | 'error'

export interface TabMeta {
  author?: string
  channelName?: string
  startedTs?: string
  activeTs?: string
  hasUnread: boolean
  firstMessageText?: string
  status: TabMetaStatus
}

// Every open tab (active or not) is polled uniformly on this interval so its
// tab-bar summary (title/From/Started/Active/unread dot) stays fresh
// regardless of which tab is currently selected. Tab selection is purely a
// rendering concern — it does not affect what gets fetched here.
const REFRESH_INTERVAL_MS = 30_000

/**
 * Fetches `/api/thread` summaries for every open tab so the tab bar can show
 * "From .../Started .../Active ..." for each one, which otherwise only
 * carries {id, channel, threadTs, name, description} from sessionStorage.
 *
 * On first appearance a tab is seeded with a 'loading' meta (only if it has
 * no existing meta yet) and fetched immediately. After that, all currently
 * open tabs are refetched together on a fixed interval so "Started"/"Active"
 * stay roughly current and unread flips show up without user action. A
 * refetch never downgrades an existing 'ready' meta back to 'loading' — it
 * either replaces it with fresh 'ready' data or marks it 'error', so a tab's
 * last-known info never blanks out while a new fetch is in flight. In-flight
 * requests are deduped per tab so overlapping fetches (e.g. a new tab
 * appearing right before an interval tick) don't race.
 */
export function useTabMetas(tabs: Tab[]): Map<string, TabMeta> {
  const [metas, setMetas] = useState<Map<string, TabMeta>>(new Map())
  const tabsRef = useRef<Tab[]>(tabs)
  const metasRef = useRef<Map<string, TabMeta>>(metas)
  const inFlight = useRef<Set<string>>(new Set())
  tabsRef.current = tabs
  metasRef.current = metas

  // Drop metas for tabs that are no longer open. Keyed off the tab id set
  // (not the array reference) so a rename (which changes `name` but not
  // `id`) doesn't churn this.
  const tabIdsKey = tabs.map((tab) => tab.id).join(',')
  useEffect(() => {
    const ids = new Set(tabsRef.current.map((tab) => tab.id))
    setMetas((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const id of next.keys()) {
        if (!ids.has(id)) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [tabIdsKey])

  useEffect(() => {
    // No `cancelled` guard here: this effect's cleanup runs both on a real
    // unmount and on React 18 Strict Mode's deliberate mount/cleanup/remount
    // cycle. Gating setState on a "was this run cancelled" flag combined
    // with a persistent "have we already started fetching this tab" set
    // (the previous `knownIdsRef` design) meant Strict Mode's first,
    // cancelled run could permanently mark a tab as "known" without ever
    // recording a result, so the second run would find nothing left to
    // fetch and the tab stayed 'loading' forever.
    //
    // Instead, "does this tab need fetching" is derived from actual state
    // (does it have a 'ready' meta yet?) via metasRef, not from a ref that
    // outlives cleanup. That makes this self-healing: if a fetch never
    // completes (or its setState is skipped for any reason), the tab still
    // lacks a 'ready' meta, so the next effect run (Strict Mode's second
    // mount, or the next interval tick) fetches it again. `inFlight` still
    // dedupes truly concurrent fetches for the same tab.

    async function fetchOne(tab: Tab) {
      if (inFlight.current.has(tab.id)) {
        return
      }
      inFlight.current.add(tab.id)
      try {
        const resp = await getThread(tab.channel, tab.threadTs)
        const derived = deriveThreadMeta(resp)
        setMetas((prev) => {
          const next = new Map(prev)
          next.set(tab.id, { ...derived, status: 'ready' })
          return next
        })
      } catch {
        setMetas((prev) => {
          const next = new Map(prev)
          const existing = next.get(tab.id)
          next.set(tab.id, { ...(existing ?? { hasUnread: false }), status: 'error' })
          return next
        })
      } finally {
        inFlight.current.delete(tab.id)
      }
    }

    function fetchAll(tabsToFetch: Tab[]) {
      for (const tab of tabsToFetch) {
        void fetchOne(tab)
      }
    }

    // Fetch any currently open tab that doesn't yet have a 'ready' meta
    // (brand-new tabs, or tabs whose previous fetch attempt never landed).
    // Existing 'ready' tabs are left alone here — they get refreshed on the
    // interval below, not on every render of this effect.
    const tabsNeedingFetch = tabsRef.current.filter(
      (tab) => metasRef.current.get(tab.id)?.status !== 'ready',
    )
    if (tabsNeedingFetch.length > 0) {
      setMetas((prev) => {
        const next = new Map(prev)
        for (const tab of tabsNeedingFetch) {
          // Only seed 'loading' for tabs with no existing meta yet — never
          // downgrade an already-'ready' meta back to 'loading' (an
          // 'error' meta is left as-is here too, so its last-known fields
          // survive until the refetch below resolves).
          if (!next.has(tab.id)) {
            next.set(tab.id, { hasUnread: false, status: 'loading' })
          }
        }
        return next
      })
      fetchAll(tabsNeedingFetch)
    }

    const interval = setInterval(() => {
      fetchAll(tabsRef.current)
    }, REFRESH_INTERVAL_MS)

    return () => {
      clearInterval(interval)
    }
  }, [tabIdsKey])

  return metas
}
