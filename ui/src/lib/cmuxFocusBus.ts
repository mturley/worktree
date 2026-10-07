import type { CmuxFocusMsg } from "../api/types"

/**
 * Hands the stream's cmux_focus events from useSSE, which owns the one
 * EventSource, to CmuxFollower, which decides what to do with them.
 */
const listeners = new Set<(msg: CmuxFocusMsg) => void>()

export function onCmuxFocus(listener: (msg: CmuxFocusMsg) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function emitCmuxFocus(msg: CmuxFocusMsg): void {
  listeners.forEach((l) => l(msg))
}
