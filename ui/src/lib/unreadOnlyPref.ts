/**
 * The "Show unreads only" choice, remembered per browser.
 *
 * One value for the whole UI: the home page and every worktree page read and
 * write the same key, so narrowing to unread on one carries to the others.
 * localStorage for the same reason as worktreeSortPref.ts — it is a
 * preference, and a new tab should keep it.
 */
export const UNREAD_ONLY_KEY = "worktree.unreadOnly"

/** The saved value, or null when storage is blocked (private windows throw). */
export function readUnreadOnly(): boolean | null {
  try {
    return window.localStorage.getItem(UNREAD_ONLY_KEY) === "true"
  } catch {
    return null
  }
}

/** Whether the value was saved; false when storage is blocked. */
export function writeUnreadOnly(value: boolean): boolean {
  try {
    window.localStorage.setItem(UNREAD_ONLY_KEY, value ? "true" : "false")
    return true
  } catch {
    return false
  }
}
