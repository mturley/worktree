import { useEffect, useLayoutEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"

/**
 * Module-level refcount of mounted `useWorktreeGit` observers that currently
 * want `fetch: true`, keyed by path. All observers for a path share one
 * query, so the server only ever sees one request per path per interval; the
 * query's `fetch` argument is "does ANY mounted observer for this path want
 * it right now", not "does THIS observer want it".
 */
const fetchWantedCounts = new Map<string, number>()

function fetchWanted(path: string): boolean {
  return (fetchWantedCounts.get(path) ?? 0) > 0
}

/**
 * The Code tab's polled git status. Polls every 15s while a mounted observer
 * for this path wants `fetch` (a Code/diff view is open), 30s otherwise;
 * pauses in the background, and refetches the moment the tab becomes visible
 * again. `fetch` asks the server to nudge its background `git fetch`.
 *
 * All observers for the same path (fetch-wanting or not) share ONE query, so
 * opening a non-fetch summary card and a fetch-wanting diff view for the same
 * worktree costs one request, not two.
 */
export function useWorktreeGit(path: string, opts: { fetch: boolean }) {
  const qc = useQueryClient()

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") qc.invalidateQueries({ queryKey: ["worktree-git", path] })
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [qc, path])

  // Layout effect so the refcount is up to date (and any invalidate issued)
  // before react-query's own mount effect runs its fetch, which decides
  // `fetch` by reading the refcount at call time.
  useLayoutEffect(() => {
    if (!opts.fetch || !path) return
    const before = fetchWantedCounts.get(path) ?? 0
    fetchWantedCounts.set(path, before + 1)
    // Went 0 -> 1: a fetch-wanting observer just mounted. Nudge the shared
    // query to refetch with fetch=true right away, rather than waiting for
    // whichever observer's interval fires next (up to 30s).
    if (before === 0) qc.invalidateQueries({ queryKey: ["worktree-git", path] })
    return () => {
      const current = fetchWantedCounts.get(path) ?? 0
      if (current <= 1) fetchWantedCounts.delete(path)
      else fetchWantedCounts.set(path, current - 1)
    }
  }, [qc, path, opts.fetch])

  return useQuery({
    queryKey: ["worktree-git", path],
    queryFn: () => api.worktreeGit(path, fetchWanted(path)),
    enabled: !!path,
    // Each mounted observer runs its own refetchInterval timer against the
    // shared query, so the shortest requested interval wins: 15s while this
    // observer wants fetch, 30s otherwise.
    refetchInterval: opts.fetch ? 15_000 : 30_000,
    refetchIntervalInBackground: false,
  })
}
