import { isSortMode, type SortDir, type SortMode } from "./worktreeSort"

/**
 * The home page sort choice, remembered per browser.
 *
 * localStorage rather than sessionStorage (contrast bannerDismiss.ts): this
 * is a preference, and a new tab or a restored cmux pane should keep it. It
 * is deliberately per-browser, not server state — the phone and the desktop
 * can sort differently.
 */
const MODE_KEY = "worktree.home.sort.mode"
const DIR_KEY = "worktree.home.sort.createdDir"

/** The saved mode, or null when none is saved or the value is unrecognised. */
export function readSortMode(): SortMode | null {
  try {
    const v = window.localStorage.getItem(MODE_KEY)
    return isSortMode(v) ? v : null
  } catch {
    // Blocked storage (private windows) throws outright; fall back to the default.
    return null
  }
}

export function writeSortMode(mode: SortMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode)
  } catch {
    // The hook's own state still applies the choice; only the memory is lost.
  }
}

export function readCreatedDir(): SortDir {
  try {
    return window.localStorage.getItem(DIR_KEY) === "desc" ? "desc" : "asc"
  } catch {
    return "asc"
  }
}

export function writeCreatedDir(dir: SortDir): void {
  try {
    window.localStorage.setItem(DIR_KEY, dir)
  } catch {
    // As writeSortMode.
  }
}
