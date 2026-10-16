import { useMemo, useState } from "react"
import { useAllResources } from "./useAllResources"
import {
  EMPTY_FILTER, matchesFilter, sortResources, type ResourceFilter, type ResourceSortMode, type SortDir,
} from "../lib/resourceListFilter"
import { matchResource } from "../lib/search"

/**
 * The Resources tab's data, sort and filters, in one place. Owned by the page
 * rather than the panel: the sort control and count sit in the page's tab
 * bar when wide, apart from the list they drive.
 */
export function useResourcesView(unreadOnly: boolean, terms: string[] = []) {
  const query = useAllResources()
  const [mode, setMode] = useState<ResourceSortMode>("updated")
  const [dir, setDir] = useState<SortDir>("desc")
  const [filter, setFilter] = useState<ResourceFilter>(EMPTY_FILTER)
  const all = useMemo(() => query.data ?? [], [query.data])
  const shown = useMemo(
    () => sortResources(all.filter((r) => matchesFilter(r, filter, unreadOnly) && (terms.length === 0 || matchResource(r, terms) !== null)), mode, dir),
    [all, filter, unreadOnly, terms, mode, dir],
  )
  return {
    query, all, shown, mode, setMode, dir, setDir, filter, setFilter, unreadOnly, terms,
    /** Whether anything narrows the list, so the count says "N of M". */
    filtered: filter.type !== null || unreadOnly || terms.length > 0,
  }
}

export type ResourcesView = ReturnType<typeof useResourcesView>
