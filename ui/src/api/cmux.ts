import { useQuery } from "@tanstack/react-query"
import { api } from "./client"
import type { CmuxBrowserTab, CmuxWorkspace } from "./types"
import { findResourceTab, tabMatchKey } from "../lib/resourceTab"

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

export const cmuxBrowserTabsKey = ["cmux-browser-tabs"] as const

/**
 * The cmux browser tab already showing a PR or Jira issue, in any workspace,
 * preferring the worktree's own (see findResourceTab) — or null for other
 * resource types, or when cmux is unavailable. One page-wide query, so every
 * card mounted at once shares a single `cmux tree --all` per poll.
 */
export function useResourceCmuxTab(path: string | undefined, type: string, url: string): CmuxBrowserTab | null {
  const key = tabMatchKey(type, url)
  const tabs = useQuery({
    queryKey: cmuxBrowserTabsKey,
    queryFn: () => api.cmuxBrowserTabs(),
    enabled: key !== null,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  })
  const cmux = useCmux()
  if (key === null) return null
  const own = path && cmux.data?.available ? (cmux.data.matches?.[path] ?? []) : []
  return findResourceTab(tabs.data, type, key, own.map((w) => w.ref))
}
