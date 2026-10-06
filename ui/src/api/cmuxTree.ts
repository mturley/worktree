import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { api } from "./client"
import type { CmuxActionResult } from "./types"

export const cmuxTreeKey = (path: string) => ["cmux-tree", path] as const

/**
 * One worktree's cmux workspaces with their panes and tabs. Polled every 5s,
 * but only while something mounts it (the cmux card tab), only while the page
 * is visible, and not while a drag-move is settling (`paused`).
 */
export function useCmuxTree(path: string, paused: boolean) {
  return useQuery({
    queryKey: cmuxTreeKey(path),
    queryFn: () => api.cmuxTree(path),
    refetchInterval: paused ? false : 5_000,
    refetchIntervalInBackground: false,
  })
}

/**
 * Runs one cmux action, then refetches this worktree's tree and the shared
 * workspace list (whose titles and colours the page header shows). Resolves
 * to an error message, or null on success. No optimistic update: cmux is the
 * truth, and the refetch shows it.
 */
export function useCmuxAction(path: string) {
  const qc = useQueryClient()
  return useCallback(
    async (action: () => Promise<CmuxActionResult>): Promise<string | null> => {
      let message: string | null = null
      try {
        const r = await action()
        if (!r.ok) message = r.error || "cmux did not accept that"
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: cmuxTreeKey(path) }),
        qc.invalidateQueries({ queryKey: ["cmux"] }),
      ])
      return message
    },
    [qc, path],
  )
}
