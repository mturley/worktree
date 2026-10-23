import { createContext, useContext } from "react"
import { useSearchQuery } from "../../hooks/useSearchQuery"
import { useSeeEverything } from "../../hooks/useSeeEverything"
import { useUnreadOnly } from "../../hooks/useUnreadOnly"

/**
 * What narrows the page, and the one way back from all of it.
 *
 * The search and Unreads only are page-independent (URL, shared store), but
 * the source/event-type and Resources filters are each page's own state, so
 * the page provides this: Esc and every narrowing line's link run `clearAll`,
 * and the link's label counts what's on (see clearLabel).
 */
export interface Narrowing {
  search: boolean
  unread: boolean
  /** Any of the page's filters (sources, event types, Resources filters). */
  filters: boolean
  /** Clears the search, Unreads only and every filter on the page. */
  clearAll: () => void
  /**
   * Whether the page's next Esc is `clearAll`, so the links show its hint.
   * Absent means it is; a page whose Esc takes another step first (the
   * worktree page's details card back to Notes) says false meanwhile.
   */
  escHint?: boolean
}

export const NarrowingContext = createContext<Narrowing | null>(null)

/** The page's narrowing; without a provider, just the search and Unreads only. */
export function useNarrowing(): Narrowing {
  const page = useContext(NarrowingContext)
  const { terms } = useSearchQuery()
  const [unread] = useUnreadOnly()
  const { seeEverything } = useSeeEverything()
  return page ?? { search: terms.length > 0, unread, filters: false, clearAll: seeEverything }
}

/**
 * Names what the link undoes: the one thing that's on, or "See everything"
 * when more than one is (or when it's Unreads only, which "clear" doesn't fit).
 */
export function clearLabel(n: Pick<Narrowing, "search" | "unread" | "filters">): string {
  const on = Number(n.search) + Number(n.unread) + Number(n.filters)
  if (on === 1 && n.search) return "Clear search"
  if (on === 1 && n.filters) return "Clear filters"
  return "See everything"
}
