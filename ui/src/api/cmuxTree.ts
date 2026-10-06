import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { api } from "./client"
import type { CmuxActionResult, CmuxMove, CmuxTreeResponse, CmuxTreeWorkspace } from "./types"
import { applyMove } from "../lib/cmuxMove"

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

/**
 * How long a successful move waits before refetching. cmux was seen to answer
 * a `tree` issued right after a move with the OLD layout, so refetching at
 * once would snap the tab back to where it came from for one poll.
 */
export const MOVE_SETTLE_MS = 1000

/**
 * Drag-and-drop moves, optimistic: the tree cache shows the move at once (via
 * applyMove), the request goes out, and then cmux's truth is re-read — after
 * MOVE_SETTLE_MS on success, immediately on failure or a stale guard (which
 * is the rollback). `moving` pauses the 5s poll meanwhile.
 */
export function useCmuxMove(path: string) {
  const qc = useQueryClient()
  const [inFlight, setInFlight] = useState(0)
  const move = useCallback(
    async (ws: CmuxTreeWorkspace, m: CmuxMove): Promise<string | null> => {
      const key = cmuxTreeKey(path)
      setInFlight((n) => n + 1)
      await qc.cancelQueries({ queryKey: key })
      qc.setQueryData<CmuxTreeResponse>(key, (old) =>
        old && { ...old, workspaces: old.workspaces.map((w) => (w.id === ws.id ? applyMove(w, m) : w)) },
      )
      let message: string | null = null
      try {
        const r = await api.cmuxMoveTab(ws.id, m)
        if (!r.ok) message = r.error || "cmux did not move the tab"
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      if (message === null) await new Promise((resolve) => setTimeout(resolve, MOVE_SETTLE_MS))
      setInFlight((n) => n - 1)
      await qc.invalidateQueries({ queryKey: key })
      return message
    },
    [qc, path],
  )
  return { move, moving: inFlight > 0 }
}
