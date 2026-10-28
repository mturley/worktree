import { useSyncExternalStore } from "react"
import { UNREAD_ONLY_KEY, readUnreadOnly, writeUnreadOnly } from "../lib/unreadOnlyPref"
import { setTaskListPrefs } from "./useTaskListPrefs"

/**
 * Subscribers in THIS tab. The browser never fires a storage event in the tab
 * that wrote, so a write has to tell its own tab's other toggles itself.
 */
const listeners = new Set<() => void>()

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  // Other tabs arrive only as storage events. A null key means another tab
  // cleared storage outright.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === UNREAD_ONLY_KEY) onChange()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener("storage", onStorage)
  }
}

/**
 * This tab's value for when storage is blocked. Without it the toggle would
 * refuse to move: the read after the write would still say off. Unused while
 * storage works, which stays the truth so another tab's change wins.
 */
let fallback = false

function getSnapshot(): boolean {
  return readUnreadOnly() ?? fallback
}

function setUnreadOnly(value: boolean): void {
  // Narrowing to unread collapses the task panel out of the way; widening
  // back puts it at its default level. Only on a change, so re-setting the
  // same value leaves a panel the user has opened since alone.
  if (value !== getSnapshot()) setTaskListPrefs({ collapsed: value })
  if (!writeUnreadOnly(value)) fallback = value
  listeners.forEach((l) => l())
}

/**
 * The UI-wide "Unreads only" choice: shared by every toggle on every page,
 * remembered per browser, and kept in step across open tabs.
 */
export function useUnreadOnly(): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot)
  return [value, setUnreadOnly]
}
