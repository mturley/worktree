import { useCallback } from "react"
import { useSearchQuery } from "./useSearchQuery"
import { useUnreadOnly } from "./useUnreadOnly"

/**
 * The way back to an unnarrowed page: clears the search and turns Unreads
 * only off. Esc does it, and so does every "See everything" link. Source and
 * type filters are left alone — they have their own Clear filters.
 *
 * `active` is whether there is anything to undo, so Esc stays inert (and
 * can blur the bar) when there isn't.
 */
export function useSeeEverything(): { active: boolean; seeEverything: () => void } {
  const { q, setQ } = useSearchQuery()
  const [unreadOnly, setUnreadOnly] = useUnreadOnly()
  const seeEverything = useCallback(() => {
    if (q) setQ("")
    setUnreadOnly(false)
  }, [q, setQ, setUnreadOnly])
  return { active: q.trim().length > 0 || unreadOnly, seeEverything }
}
