import { useSyncExternalStore } from "react"
import {
  TASK_LIST_KEY,
  parseTaskListPrefs,
  readTaskListPrefsRaw,
  writeTaskListPrefs,
  type StoredTaskListPrefs,
} from "../lib/taskListPrefs"

/**
 * Subscribers in THIS tab. The browser never fires a storage event in the tab
 * that wrote, so a write tells its own tab's other lists itself (as
 * useUnreadOnly does).
 */
const listeners = new Set<() => void>()

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === TASK_LIST_KEY) onChange()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener("storage", onStorage)
  }
}

/** This tab's value while storage is blocked; unused while it works. */
let fallback: string | null = null
// useSyncExternalStore needs a stable snapshot: re-parse only when the raw string changes.
let cachedRaw: string | null | undefined
let cached: StoredTaskListPrefs = parseTaskListPrefs(null)

function getSnapshot(): StoredTaskListPrefs {
  const stored = readTaskListPrefsRaw()
  const raw = stored === undefined ? fallback : stored
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cached = parseTaskListPrefs(raw)
  }
  return cached
}

function setPrefs(p: Partial<StoredTaskListPrefs>): void {
  const next = { ...getSnapshot(), ...p }
  if (!writeTaskListPrefs(next)) fallback = JSON.stringify(next)
  listeners.forEach((l) => l())
}

/**
 * The task lists' shared view prefs (pinned included): one value for every
 * mounted list, remembered per browser, and kept in step across tabs.
 */
export function useTaskListPrefs(): [StoredTaskListPrefs, (p: Partial<StoredTaskListPrefs>) => void] {
  return [useSyncExternalStore(subscribe, getSnapshot), setPrefs]
}
