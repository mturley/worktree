/** Whether /mini shows Activity and Tasks side by side, remembered per browser. */
const MINI_EXPANDED_KEY = "worktree.miniExpanded"

/** The saved value; false when there is none or storage is blocked. */
export function readMiniExpanded(): boolean {
  try {
    return window.localStorage.getItem(MINI_EXPANDED_KEY) === "true"
  } catch {
    return false
  }
}

export function writeMiniExpanded(value: boolean): void {
  try {
    window.localStorage.setItem(MINI_EXPANDED_KEY, value ? "true" : "false")
  } catch {
    // Blocked storage: it holds for this page's life only.
  }
}
