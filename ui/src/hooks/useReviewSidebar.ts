import { useSyncExternalStore } from "react"

/** Whether the review comments sidebar is open, per browser tab (like useFollowCmux). */
export const REVIEW_SIDEBAR_KEY = "worktree.reviewSidebar"

const listeners = new Set<() => void>()

/** This tab's value for when storage is blocked. Unused while storage works. */
let fallback = false

function read(): boolean {
  try {
    return window.sessionStorage.getItem(REVIEW_SIDEBAR_KEY) === "true"
  } catch {
    return fallback
  }
}

export function setReviewSidebar(open: boolean): void {
  try {
    window.sessionStorage.setItem(REVIEW_SIDEBAR_KEY, open ? "true" : "false")
  } catch {
    fallback = open
  }
  listeners.forEach((l) => l())
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => { listeners.delete(onChange) }
}

export function useReviewSidebar(): [boolean, (open: boolean) => void] {
  return [useSyncExternalStore(subscribe, read), setReviewSidebar]
}
