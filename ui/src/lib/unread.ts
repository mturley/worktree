import type { ResourceDTO } from "../api/types"

/**
 * Whether a resource has activity the user has not seen.
 *
 * Two sources, one question. A Slack thread's read state belongs to Slack and
 * arrives as the poller-cached `has_unread`; everything else is counted
 * against worktree's own per-resource cursor. Every surface calls this rather
 * than branching on type itself, so the split stays in one place — and so
 * adding a third source later touches one file.
 */
export function hasUnread(r: ResourceDTO): boolean {
  if (r.type === "slack") return !!r.has_unread
  return (r.unread_count ?? 0) > 0
}
