import type { ResourceDTO, WorktreeSummary } from "../api/types"
import { hasUnread } from "./unread"

/**
 * A home-page worktree card narrowed by Unreads only: its resource list keeps
 * only the resources with unread activity, and gains the RELATED ones that
 * have some — a card normally lists its focus resources alone, which would
 * leave a related resource's unreads with nowhere to show.
 *
 * `followed` is every resource the worktree follows (focus and related, as
 * the Resources tab's all-resources query has them), already narrowed to the
 * selected sources. Until it loads, only the focus resources are narrowed.
 *
 * The "+ N related" line is dropped: every related resource it would count
 * is either listed now or has nothing unread.
 */
export function filterWorktreeByUnread(w: WorktreeSummary, followed: ResourceDTO[] | undefined): WorktreeSummary {
  const key = (r: ResourceDTO) => `${r.type}:${r.id}`
  const focusKeys = new Set(w.focus_resources.map(key))
  const related = (followed ?? []).filter((r) => !focusKeys.has(key(r)) && hasUnread(r))
  return {
    ...w,
    focus_resources: [...w.focus_resources.filter(hasUnread), ...related],
    related_by_type: {},
  }
}
