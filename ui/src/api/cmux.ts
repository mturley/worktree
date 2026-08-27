import { useQuery } from "@tanstack/react-query"
import { api } from "./client"

/**
 * One shared query for every card on the page.
 *
 * The key is constant, so N worktree cards cost ONE `cmux workspace list` per
 * refetch rather than N. Refetched on an interval because cmux titles carry
 * live agent-status glyphs (e.g. "◐ handler-ratelimits") and do go stale.
 */
export function useCmux() {
  return useQuery({
    queryKey: ["cmux"],
    queryFn: () => api.cmux(),
    refetchInterval: 15_000,
  })
}
