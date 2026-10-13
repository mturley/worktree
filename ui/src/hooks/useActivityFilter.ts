import { useCallback, useMemo, useState } from "react"
import { eventTypesFor } from "../lib/eventTypeFilter"

/**
 * The Activity feed's source toggles plus their per-source subfilters.
 *
 * Kept together because they are not independent: the subfilters belong to
 * the selected source, so changing the source has to clear them — "Comments"
 * under GitHub is a different set of event types from "Comments" under Jira.
 */
export function useActivityFilter() {
  const [sources, setSourcesState] = useState<string[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const setSources = useCallback((next: string[]) => {
    setSourcesState(next)
    setCategories([])
  }, [])
  const eventTypes = useMemo(() => eventTypesFor(sources, categories), [sources, categories])
  return { sources, setSources, categories, setCategories, eventTypes }
}
