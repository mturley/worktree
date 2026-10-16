import { useCallback, useMemo } from "react"
import { useLocation, useSearch } from "wouter"
import { useDebouncedValue } from "@mantine/hooks"
import { parseQuery } from "../lib/search"

const PARAM = "q"

/** How long typing must pause before the server is asked. */
export const SEARCH_DEBOUNCE_MS = 250

/**
 * The page's search query, kept in the URL as `?q=` so Back and reload keep
 * it. Written with replace: typing must not leave one history entry per
 * keystroke. Other params (`resource`, `tab`) are preserved.
 *
 * `terms` is for browser-side filtering and highlighting, immediately;
 * `debouncedQ` (trimmed) is for server requests.
 */
export function useSearchQuery() {
  const search = useSearch()
  const [location, navigate] = useLocation()
  const q = new URLSearchParams(search).get(PARAM) ?? ""
  const setQ = useCallback(
    (next: string) => {
      const params = new URLSearchParams(search)
      if (next) params.set(PARAM, next)
      else params.delete(PARAM)
      const qs = params.toString()
      navigate(qs ? `${location}?${qs}` : location, { replace: true })
    },
    [search, location, navigate],
  )
  const terms = useMemo(() => parseQuery(q), [q])
  const [debouncedQ] = useDebouncedValue(terms.length ? q.trim() : "", SEARCH_DEBOUNCE_MS)
  return { q, setQ, terms, debouncedQ }
}
