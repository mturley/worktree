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
const CREATED_DIR_KEY = "worktree.home.sort.createdDir"
const NAME_DIR_KEY = "worktree.home.sort.nameDir"

/** Every key this module owns, for telling our storage events from others. */
export const SORT_PREF_KEYS: readonly string[] = [MODE_KEY, CREATED_DIR_KEY, NAME_DIR_KEY]

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

/** Directions default to ascending, including for unrecognised values. */
function readDir(key: string): SortDir {
  try {
    return window.localStorage.getItem(key) === "desc" ? "desc" : "asc"
  } catch {
    return "asc"
  }
}

function writeDir(key: string, dir: SortDir): void {
  try {
    window.localStorage.setItem(key, dir)
  } catch {
    // As writeSortMode.
  }
}

export const readCreatedDir = (): SortDir => readDir(CREATED_DIR_KEY)
export const writeCreatedDir = (dir: SortDir): void => writeDir(CREATED_DIR_KEY, dir)
export const readNameDir = (): SortDir => readDir(NAME_DIR_KEY)
export const writeNameDir = (dir: SortDir): void => writeDir(NAME_DIR_KEY, dir)
