import { useSyncExternalStore } from "react"

/**
 * When the server last checked what the Environment tab's sections show, as
 * ISO times from the stream's heartbeat (internal/webui/stream.go
 * heartbeatMsg). `listeners` is absent while port scanning is off or before
 * the first scan.
 */
export interface Checks {
  listeners?: string
  kubeconfig?: string
}

let current: Checks = {}
const subscribers = new Set<() => void>()

export function setChecks(next: Checks): void {
  current = next
  for (const fn of subscribers) fn()
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  return () => {
    subscribers.delete(fn)
  }
}

export function useChecks(): Checks {
  return useSyncExternalStore(subscribe, () => current)
}
