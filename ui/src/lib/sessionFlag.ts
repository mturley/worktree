import { useSyncExternalStore } from "react"

export interface SessionFlag {
  read(): boolean
  set(value: boolean): void
  use(): [boolean, (value: boolean) => void]
}

/**
 * A boolean kept in this tab's sessionStorage under `key`, observable from
 * React. Stored as "true"/"false"; anything else reads as false.
 *
 * sessionStorage is this tab's alone, so no storage event can change it: only
 * this tab's own writes, which notify directly.
 */
export function sessionFlag(key: string): SessionFlag {
  const listeners = new Set<() => void>()
  // This tab's value for when storage is blocked (private windows throw), so
  // a toggle still moves. Unused while storage works.
  let fallback = false

  function read(): boolean {
    try {
      return window.sessionStorage.getItem(key) === "true"
    } catch {
      return fallback
    }
  }

  function set(value: boolean): void {
    try {
      window.sessionStorage.setItem(key, value ? "true" : "false")
    } catch {
      fallback = value
    }
    listeners.forEach((l) => l())
  }

  function subscribe(onChange: () => void): () => void {
    listeners.add(onChange)
    return () => { listeners.delete(onChange) }
  }

  return {
    read,
    set,
    use: () => [useSyncExternalStore(subscribe, read), set],
  }
}
