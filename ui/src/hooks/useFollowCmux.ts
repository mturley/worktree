import { useSyncExternalStore } from "react"

/**
 * "Follow cmux focus", per browser tab.
 *
 * sessionStorage, not localStorage: following is a role one tab plays (the
 * one beside the terminal), and every tab following at once would have them
 * all jump together. The value still survives a reload of that tab.
 */
export const FOLLOW_CMUX_KEY = "worktree.followCmuxFocus"

const listeners = new Set<() => void>()

/**
 * This tab's value for when storage is blocked (private windows throw), so the
 * toggle still moves. Unused while storage works.
 */
let fallback = false

function read(): boolean {
  try {
    return window.sessionStorage.getItem(FOLLOW_CMUX_KEY) === "true"
  } catch {
    return fallback
  }
}

export function setFollowCmux(value: boolean): void {
  try {
    window.sessionStorage.setItem(FOLLOW_CMUX_KEY, value ? "true" : "false")
  } catch {
    fallback = value
  }
  listeners.forEach((l) => l())
}

function subscribe(onChange: () => void): () => void {
  // sessionStorage is this tab's alone, so no storage event can change it:
  // only this tab's own writes, which notify directly.
  listeners.add(onChange)
  return () => { listeners.delete(onChange) }
}

/** Whether this tab follows cmux focus. Shared by the toggle on every page. */
export function useFollowCmux(): [boolean, (value: boolean) => void] {
  return [useSyncExternalStore(subscribe, read), setFollowCmux]
}
