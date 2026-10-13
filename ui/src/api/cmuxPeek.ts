import { useQuery } from "@tanstack/react-query"
import { api } from "./client"
import type { CmuxTab } from "./types"

/**
 * How a tab's peek is fetched. Terminals change under you, so they refresh
 * every 5s while the card is open. A browser peek is a ~1s, ~200KB
 * screenshot and a markdown peek a file read: one fetch per open, nothing
 * kept once the card closes, so reopening always shows the tab as it is now.
 */
export function peekQueryOptions(type: string) {
  return {
    refetchInterval: type === "terminal" ? 5000 : (false as const),
    staleTime: 0,
    gcTime: 0,
    retry: false as const,
  }
}

/** A tab's peek. Mounted only while its hover card is open — mounting IS enabling. */
export function useCmuxPeek(workspaceId: string, tab: CmuxTab) {
  return useQuery({
    queryKey: ["cmux-peek", workspaceId, tab.ref],
    queryFn: () => api.cmuxPeek(workspaceId, tab.ref),
    ...peekQueryOptions(tab.type),
  })
}
