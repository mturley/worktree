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
  clear: () => void
  toggle: (key: ResourceKey) => void
} {
  const search = useSearch()
  const [location, navigate] = useLocation()
  const selected = parseResourceKey(new URLSearchParams(search).get(PARAM))

  const setParam = useCallback(
    (value: string | null) => {
      const params = new URLSearchParams(search)
      if (value === null) params.delete(PARAM)
      else params.set(PARAM, value)
      const qs = params.toString()
      navigate(qs ? `${location}?${qs}` : location)
    },
    [search, location, navigate],
  )

  const select = useCallback((key: ResourceKey) => setParam(serializeResourceKey(key)), [setParam])
  const clear = useCallback(() => setParam(null), [setParam])
  const toggle = useCallback(
    (key: ResourceKey) => (resourceKeyEquals(selected, key) ? clear() : select(key)),
    [selected, clear, select],
  )

  return { selected, select, clear, toggle }
}
