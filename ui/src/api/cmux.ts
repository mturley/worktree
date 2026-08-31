import { useQuery } from "@tanstack/react-query"
import { api } from "./client"
import type { CmuxWorkspace } from "./types"

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

/**
 * The cmux workspaces matching one worktree, or an empty array when cmux is
 * unavailable or nothing matches.
 *
 * Shares `useCmux`'s single query, so a card can ask "do I have a workspace?"
 * without a second request. WorktreeCard needs this to decide whether the
 * workspace name is acting as the card's headline, which in turn decides how
 * large its own title renders.
 */
export function useCmuxMatches(path: string): CmuxWorkspace[] {
  const cmux = useCmux()
  if (!cmux.data?.available) return []
  return cmux.data.matches?.[path] ?? []
}
