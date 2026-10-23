import { useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import type { WorktreeGit } from "../api/types"

/**
 * The Code tab's polled git status. Polls every 5s while the page is visible,
 * pauses in the background, and refetches the moment the tab becomes visible
 * again. `fetch` asks the server to nudge its background `git fetch`.
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

  return useQuery({
    queryKey: ["worktree-git", path, opts.fetch],
    queryFn: () => api.worktreeGit(path, opts.fetch),
    enabled: !!path,
    // `fetch` is in the key, so flipping it (opening or leaving the Code tab)
    // is a new query with no data; keep showing the last result so the tab
    // badge does not blink while it loads. Leaving the tab also remounts the
    // card (it moves), which drops `prev`, so fall back to the other variant's
    // cached result. Only within the same worktree, though: another
    // worktree's status must never stand in for this one's.
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[1] === path
        ? prev
        : qc.getQueryData<WorktreeGit>(["worktree-git", path, !opts.fetch]),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })
}
