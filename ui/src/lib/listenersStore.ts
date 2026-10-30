import { useCallback, useRef, useSyncExternalStore } from "react"
import type { ListenerPort, ListenersSnapshot } from "../api/types"

/**
 * The stream's listeners_changed snapshot, handed from useSSE (which owns the
 * one EventSource) to whatever shows a worktree's listening ports.
 */
let snapshot: ListenersSnapshot | null = null
const subscribers = new Set<() => void>()

export function setListeners(snap: ListenersSnapshot): void {
  snapshot = snap
  subscribers.forEach((l) => l())
}

function subscribe(l: () => void): () => void {
  subscribers.add(l)
  return () => { subscribers.delete(l) }
}

export interface PathListeners {
  enabled: boolean
  ports: ListenerPort[]
  range: string | null
}

const NO_PORTS: ListenerPort[] = []

/** null until the first snapshot arrives; ports [] when the path has none. */
export function useListeners(path: string): PathListeners | null {
  // getSnapshot must return the same object while nothing changed, so the
  // derived value is cached per (snapshot, path).
  const cache = useRef<{ snap: ListenersSnapshot; path: string; value: PathListeners } | null>(null)
  const get = useCallback((): PathListeners | null => {
    const snap = snapshot
    if (!snap) return null
    const c = cache.current
    if (c && c.snap === snap && c.path === path) return c.value
    const value = {
      enabled: snap.enabled,
      ports: snap.ports?.[path] ?? NO_PORTS,
      range: snap.ranges?.[path] ?? null,
    }
    cache.current = { snap, path, value }
    return value
  }, [path])
  return useSyncExternalStore(subscribe, get)
}

/** "4090-4099" → "4090–4099" */
export function formatRange(range: string): string {
  return range.replace("-", "–")
}
