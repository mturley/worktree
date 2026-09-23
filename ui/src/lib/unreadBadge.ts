import type { WorktreeSummary } from "../api/types"

export interface UnreadBadge {
  /** Whether ANY worktree has activity the user has not seen. */
  unread: boolean
  /** Unread events across every worktree. Can be 0 while `unread` is true. */
  count: number
}

/**
 * The app-wide unread state, as the tab has to say it.
 *
 * Summed from `has_unread`/`unread_count` on the worktree list rather than
 * from resources: `has_unread` covers RELATED resources too, which the
 * summary's `focus_resources` do not carry (see WorktreeSummary).
 *
 * A worktree's count only counts when `has_unread` says so. An older cached
 * response omits `has_unread` entirely, and trusting a stale `unread_count`
 * beside it would flash the tab for a worktree the server no longer calls
 * unread.
 */
export function unreadBadge(worktrees: WorktreeSummary[] | undefined): UnreadBadge {
  // Array.isArray, not `?? []`: the list is null on the wire when Go marshals
  // an empty slice, and the query holds whatever the server sent. This runs on
  // every render of the whole app, so a bad shape here blanks the UI.
  if (!Array.isArray(worktrees)) return { unread: false, count: 0 }
  let unread = false
  let count = 0
  for (const w of worktrees) {
    if (!w.has_unread) continue
    unread = true
    count += w.unread_count ?? 0
  }
  return { unread, count }
}

/** The tab title with no badge on it. */
export const BASE_TITLE = "worktree"

/**
 * The document title for a badge state.
 *
 * The count leads when there is one, because it survives the window switcher
 * and the history menu, where the favicon is too small to read. A Slack thread
 * is unread without a countable tally behind it, so that case gets a dot —
 * "(0) worktree" would read as nothing to look at.
 */
export function badgeTitle({ unread, count }: UnreadBadge): string {
  if (!unread) return BASE_TITLE
  return count > 0 ? `(${count}) ${BASE_TITLE}` : `• ${BASE_TITLE}`
}
