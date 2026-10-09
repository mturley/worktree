import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"

/** Resource types that have a Linked Resources tab. */
export const LINKED_TYPES = new Set(["pr", "jira", "slack"])

/** Matches the server's cache lifetime, so remounts don't refetch early. */
const STALE_MS = 2 * 60_000

/**
 * A resource's linked resources. Fired on selection with resolveLinks
 * false (drives the tab's count, no outbound page fetches); the tab flips
 * resolveLinks on when first opened, and the placeholder shows the
 * unresolved rows until titles arrive instead of a spinner.
 */
export function useLinkedResources(type: string, id: string, resolveLinks: boolean) {
  const qc = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const key = ["linked", type, id, resolveLinks] as const
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.linkedResources(type, id, { resolveLinks }),
    staleTime: STALE_MS,
    // Carry data across the resolveLinks flip of the SAME resource only —
    // never from one resource into another's tab while it loads.
    placeholderData: (prev, prevQuery) =>
      prevQuery && prevQuery.queryKey[1] === type && prevQuery.queryKey[2] === id ? prev : undefined,
    enabled: LINKED_TYPES.has(type),
  })
  async function refresh() {
    setRefreshing(true)
    try {
      const fresh = await api.linkedResources(type, id, { resolveLinks, refresh: true })
      qc.setQueryData(key, fresh)
    } finally {
      setRefreshing(false)
    }
  }
  return {
    data: q.data,
    isLoading: q.isLoading,
    error: q.error as Error | null,
    refresh,
    refreshing,
    refetch: () => void q.refetch(),
  }
}
