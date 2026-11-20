import { useSyncExternalStore } from "react"
import type { CmuxFocusMsg } from "../api/types"

/**
 * Hands the stream's cmux_focus events from useSSE, which owns the one
 * EventSource, to CmuxFollower, which decides what to do with them.
 *
 * It also keeps the last message seen, for FollowingCmuxBanner, which says
 * when cmux is on a workspace with no worktree. `recordCmuxFocus` sets that
 * alone, without moving anything: the banner's own check on page load.
 */
const listeners = new Set<(msg: CmuxFocusMsg) => void>()
const lastListeners = new Set<() => void>()
let last: CmuxFocusMsg | null = null

export function onCmuxFocus(listener: (msg: CmuxFocusMsg) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function recordCmuxFocus(msg: CmuxFocusMsg): void {
  last = msg
  lastListeners.forEach((l) => l())
}

export function emitCmuxFocus(msg: CmuxFocusMsg): void {
  recordCmuxFocus(msg)
  listeners.forEach((l) => l(msg))
}

/** The last cmux focus message, or null before any. */
export function lastCmuxFocus(): CmuxFocusMsg | null {
  return last
}

function subscribeLast(l: () => void): () => void {
  lastListeners.add(l)
  return () => { lastListeners.delete(l) }
}

export function useLastCmuxFocus(): CmuxFocusMsg | null {
  return useSyncExternalStore(subscribeLast, lastCmuxFocus)
}
