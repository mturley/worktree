import { useCallback } from "react"
import { useLocation, useSearch } from "wouter"
import {
  parseResourceKey,
  serializeResourceKey,
  resourceKeyEquals,
  type ResourceKey,
} from "../lib/resourceKey"

const PARAM = "resource"

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
