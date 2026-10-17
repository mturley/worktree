import { useCallback } from "react"
import { useSearchQuery } from "./useSearchQuery"
import { useUnreadOnly } from "./useUnreadOnly"

/**
 * Clears the search and turns Unreads only off: the page-independent half of
 * "see everything". Pages add their own filters on top (NarrowingContext's
 * clearAll); this alone is the fallback where no page provides that.
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
