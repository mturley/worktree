import { useCallback } from "react"
import { useLocation, useSearch } from "wouter"
import {
  parseResourceKey,
  serializeResourceKey,
  resourceKeyEquals,
  type ResourceKey,
} from "../lib/resourceKey"

const PARAM = "resource"
/** The selected resource's active tab; absent means its default tab. */
const TAB_PARAM = "tab"
/** The URL params a selection lives in, for a caller clearing it in its own navigation. */
export const SELECTION_PARAMS = [PARAM, TAB_PARAM] as const

/**
 * The selected resource, stored in the URL as `?resource=<type>:<id>`.
 *
 * Keeping it in the URL (rather than component state) makes a selection
 * deep-linkable, survive a refresh, and be undone by the browser back button.
 * Crucially it is also the SINGLE source of truth shared by the wide-viewport
 * card highlight and the narrow-viewport drilldown, so resizing the viewport
 * swaps presentation without disturbing the selection.
 */
export function useSelectedResource(): {
  selected: ResourceKey | null
  select: (key: ResourceKey) => void
  clear: (opts?: { replace?: boolean }) => void
  toggle: (key: ResourceKey) => void
} {
  const search = useSearch()
  const [location, navigate] = useLocation()
  const selected = parseResourceKey(new URLSearchParams(search).get(PARAM))

  const setParam = useCallback(
    (value: string | null, replace = false) => {
      const params = new URLSearchParams(search)
      if (value === null) params.delete(PARAM)
      else params.set(PARAM, value)
      // A tab belongs to the resource it was chosen on: a new selection (or
      // none) starts on its own default tab.
      params.delete(TAB_PARAM)
      const qs = params.toString()
      navigate(qs ? `${location}?${qs}` : location, { replace })
    },
    [search, location, navigate],
  )

  const select = useCallback((key: ResourceKey) => setParam(serializeResourceKey(key)), [setParam])
  // A deliberate deselect pushes a history entry (so the back button can undo
  // it), but an automatic correction of invalid/stale input (see
  // WorktreeDetailPage's stale-selection effect) must replace instead, or it
  // traps the back button in a stale <-> clean loop.
  const clear = useCallback((opts?: { replace?: boolean }) => setParam(null, opts?.replace ?? false), [setParam])
  const toggle = useCallback(
    (key: ResourceKey) => (resourceKeyEquals(selected, key) ? clear() : select(key)),
    [selected, clear, select],
  )

  return { selected, select, clear, toggle }
}

/**
 * The selected resource's active tab, stored in the URL as `?tab=<name>` so
 * back/forward and a refresh return to the tab you were on. `tabs` lists the
 * pane's tab names, default first; the default is never written to the URL,
 * and anything not in the list reads as the default.
 *
 * Switching tabs pushes a history entry, so back steps through tab switches as
 * well as selections. `replace` is for automatic switches (e.g. bringing the
 * thread forward to show a focused message) that shouldn't add a step.
 */
export function useResourceTab(tabs: readonly string[]): [string, (tab: string, opts?: { replace?: boolean }) => void] {
  const search = useSearch()
  const [location, navigate] = useLocation()
  const raw = new URLSearchParams(search).get(TAB_PARAM)
  const current = raw && tabs.includes(raw) ? raw : tabs[0]

  const setTab = useCallback(
    (tab: string, opts?: { replace?: boolean }) => {
      if (tab === current) return
      const params = new URLSearchParams(search)
      if (tab === tabs[0]) params.delete(TAB_PARAM)
      else params.set(TAB_PARAM, tab)
      const qs = params.toString()
      navigate(qs ? `${location}?${qs}` : location, { replace: opts?.replace ?? false })
    },
    [current, tabs, search, location, navigate],
  )

  return [current, setTab]
}
