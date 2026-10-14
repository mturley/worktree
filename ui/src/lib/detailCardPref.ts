/**
 * Whether the worktree detail page's details card is collapsed into the
 * resource column rather than spanning the page under the header.
 *
 * localStorage, like the home page sort (worktreeSortPref.ts): a layout
 * preference that a new tab or a restored cmux pane should keep, and
 * deliberately per-browser — the phone never shows the collapsed layout.
 *
 * Collapsed by default: the activity column is what you read most, and it
 * gets the page's full height that way.
 */
const COLLAPSED_KEY = "worktree.detail.cardCollapsed"

export function readCardCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) !== "false"
  } catch {
    // Blocked storage (private windows) throws outright; use the default.
    return true
  }
}

export function writeCardCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, String(collapsed))
  } catch {
    // The page's own state still applies the choice; only the memory is lost.
  }
}
