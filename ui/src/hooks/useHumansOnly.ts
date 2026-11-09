import { useSyncExternalStore } from "react"

/**
 * The "Humans only" choice, remembered per browser: one value for every
 * activity feed on every page, as Unreads only is (useUnreadOnly), and for
 * the same reason — it is a preference, and a new tab should keep it.
 */
export const HUMANS_ONLY_KEY = "worktree.humansOnly"

/** Subscribers in THIS tab; the browser never fires storage in the writer. */
const listeners = new Set<() => void>()

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === HUMANS_ONLY_KEY) onChange()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener("storage", onStorage)
  }
}

/** This tab's value while storage is blocked (private windows throw). */
let fallback = false

function getSnapshot(): boolean {
  try {
    return window.localStorage.getItem(HUMANS_ONLY_KEY) === "true"
  } catch {
    return fallback
  }
}

function setHumansOnly(value: boolean): void {
  try {
    window.localStorage.setItem(HUMANS_ONLY_KEY, value ? "true" : "false")
  } catch {
    fallback = value
  }
  listeners.forEach((l) => l())
}

/**
 * Hides bots' events and CI events from the activity feeds, leaving what
 * people said and did. Filtered on the server (see useTimeline), so it is a
 * filter like the source toggles: it counts toward "N events match your
 * filters", and clearing the filters turns it off.
 */
export function useHumansOnly(): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot)
  return [value, setHumansOnly]
}
