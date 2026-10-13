import { useQuery } from "@tanstack/react-query"
import { api } from "./client"
import type { CmuxTab } from "./types"

/**
 * How a tab's peek is fetched. Terminals change under you, so they refresh
 * every 5s while the card is open and keep nothing once it closes.
 *
 * A browser peek is a ~1s, ~200KB screenshot (and a markdown peek a file
 * read), so those are cached: re-hovering a tab shows its last peek at once,
 * and only retakes it — in the background, the cached one staying on screen
 * meanwhile — once it is more than 60s old. An unused peek is dropped after
 * 10 minutes so screenshots do not pile up in memory.
 */
export function peekQueryOptions(type: string) {
  if (type === "terminal") {
    return { refetchInterval: 5000, staleTime: 0, gcTime: 0, retry: false as const }
  }
  return { refetchInterval: false as const, staleTime: 60_000, gcTime: 600_000, retry: false as const }
}

/** A tab's peek. Mounted only while its hover card is open — mounting IS enabling. */
export function useCmuxPeek(workspaceId: string, tab: CmuxTab) {
  return useQuery({
    queryKey: ["cmux-peek", workspaceId, tab.ref],
    queryFn: () => api.cmuxPeek(workspaceId, tab.ref),
    ...peekQueryOptions(tab.type),
  })
}
