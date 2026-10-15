import { useMemo, useState } from "react"
import { useAllResources } from "./useAllResources"
import {
  EMPTY_FILTER, matchesFilter, sortResources, type ResourceFilter, type ResourceSortMode, type SortDir,
} from "../lib/resourceListFilter"

/**
 * The Resources tab's data, sort and filters, in one place. Owned by the page
 * rather than the panel: the sort control and count sit in the page's tab
 * bar when wide, apart from the list they drive.
 */
export function useResourcesView(unreadOnly: boolean) {
  const query = useAllResources()
  const [mode, setMode] = useState<ResourceSortMode>("updated")
  const [dir, setDir] = useState<SortDir>("desc")
  const [filter, setFilter] = useState<ResourceFilter>(EMPTY_FILTER)
  const all = useMemo(() => query.data ?? [], [query.data])
  const shown = useMemo(
    () => sortResources(all.filter((r) => matchesFilter(r, filter, unreadOnly)), mode, dir),
    [all, filter, unreadOnly, mode, dir],
  )
  return {
    query, all, shown, mode, setMode, dir, setDir, filter, setFilter, unreadOnly,
    /** Whether anything narrows the list, so the count says "N of M". */
    filtered: filter.type !== null || unreadOnly,
  }
}

export type ResourcesView = ReturnType<typeof useResourcesView>
