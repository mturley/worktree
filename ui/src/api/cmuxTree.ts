import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useRef, useState } from "react"
import { api } from "./client"
import type { CmuxActionResult, CmuxMove, CmuxTabRef, CmuxTreeResponse, CmuxTreeWorkspace } from "./types"
import { applyClose, applyMove } from "../lib/cmuxMove"

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
    // A focus/reconnect refetch during the settle window would race the
    // move's own refetch and could snap the tab back before cmux has caught
    // up, same as the interval poll — pause those too.
    refetchOnWindowFocus: !paused,
    refetchOnReconnect: !paused,
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
 * How long a successful close or move waits before refetching. cmux was seen
 * to answer a `tree` issued right after a move with the OLD layout, so
 * refetching at once would snap the tab back to where it came from for one
 * poll; a close takes the same path for consistency (and the server's own
 * focus/selection restore after either one needs the same kind of settling —
 * see internal/webui/cmux_tabs.go).
 */
export const CMUX_SETTLE_MS = 1000

/**
 * Shared optimistic-write plumbing for close and move: writes `apply`'s
 * result into the tree cache before `request` goes out, then re-reads cmux's
 * truth — after CMUX_SETTLE_MS on success, immediately on failure or a stale
 * guard (which is the rollback). One in-flight counter covers BOTH kinds of
 * write, so the 5s poll pauses while either is outstanding and "only the
 * last operation still in flight refetches" holds across a close and a move
 * overlapping, not just two of the same kind.
 */
function useCmuxOptimisticWrite(path: string) {
  const qc = useQueryClient()
  const [inFlight, setInFlight] = useState(0)
  // Mirrors `inFlight` so a finishing write can tell, synchronously, whether
  // it was the last one — state updates aren't visible to the same closure
  // until the next render, and a second write started during the first's
  // settle window must not have its own refetch skipped or have the first
  // write's (delayed) refetch snap it back.
  const inFlightRef = useRef(0)
  const run = useCallback(
    async (
      ws: CmuxTreeWorkspace,
      apply: (ws: CmuxTreeWorkspace) => CmuxTreeWorkspace,
      request: () => Promise<CmuxActionResult>,
      failMessage: string,
    ): Promise<string | null> => {
      const key = cmuxTreeKey(path)
      inFlightRef.current += 1
      setInFlight((n) => n + 1)
      await qc.cancelQueries({ queryKey: key })
      qc.setQueryData<CmuxTreeResponse>(key, (old) =>
        old && { ...old, workspaces: old.workspaces.map((w) => (w.id === ws.id ? apply(w) : w)) },
      )
      let message: string | null = null
      try {
        const r = await request()
        if (!r.ok) message = r.error || failMessage
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      if (message === null) await new Promise((resolve) => setTimeout(resolve, CMUX_SETTLE_MS))
      inFlightRef.current -= 1
      setInFlight((n) => n - 1)
      // Only the last write still in flight refetches: an earlier one's
      // refetch (delayed by its own settle wait) would otherwise land after a
      // later write's optimistic update and snap it back.
      if (inFlightRef.current === 0) await qc.invalidateQueries({ queryKey: key })
      return message
    },
    [qc, path],
  )
  return { run, busy: inFlight > 0 }
}

/**
 * Drag-and-drop moves and tab closes, both optimistic and sharing one
 * in-flight counter (see useCmuxOptimisticWrite): `moving` pauses the 5s
 * poll while either is outstanding.
 */
export function useCmuxMove(path: string) {
  const { run, busy } = useCmuxOptimisticWrite(path)
  const move = useCallback(
    (ws: CmuxTreeWorkspace, m: CmuxMove) => run(ws, (w) => applyMove(w, m), () => api.cmuxMoveTab(ws.id, m), "cmux did not move the tab"),
    [run],
  )
  const close = useCallback(
    (ws: CmuxTreeWorkspace, tab: CmuxTabRef) =>
      run(ws, (w) => applyClose(w, tab.surface), () => api.cmuxCloseTab(ws.id, tab), "cmux did not close the tab"),
    [run],
  )
  return { move, close, moving: busy }
}
