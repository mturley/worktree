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

export type ReviewTab = "local" | "pr"

export const REVIEW_SIDEBAR_TAB_KEY = "worktree.reviewSidebarTab"

const tabListeners = new Set<() => void>()
let tabFallback: ReviewTab = "local"

function readTab(): ReviewTab {
  try {
    return window.sessionStorage.getItem(REVIEW_SIDEBAR_TAB_KEY) === "pr" ? "pr" : "local"
  } catch {
    return tabFallback
  }
}

export function setReviewSidebarTab(tab: ReviewTab): void {
  tabFallback = tab
  try {
    window.sessionStorage.setItem(REVIEW_SIDEBAR_TAB_KEY, tab)
  } catch {
    // Storage blocked: the tab lasts for this page view.
  }
  tabListeners.forEach((l) => l())
}

function subscribeTab(onChange: () => void): () => void {
  tabListeners.add(onChange)
  return () => { tabListeners.delete(onChange) }
}

/** Which tab the review sidebar shows, per browser tab. */
export function useReviewSidebarTab(): [ReviewTab, (t: ReviewTab) => void] {
  return [useSyncExternalStore(subscribeTab, readTab), setReviewSidebarTab]
}
