import { useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"

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
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })
}
