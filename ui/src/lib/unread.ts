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

/**
 * The colour an unread thing's title takes.
 *
 * Written down once, for the same reason UnreadMarkerDot exists: the resource
 * title, the worktree card's focus line, the timeline chip and the event title
 * are one signal wearing four hats, and four copies of "blue.4" drift apart
 * the first time any of them is tweaked.
 */
export const UNREAD_COLOR = "blue.4"

/**
 * The left edge a card grows when something inside it is unread.
 *
 * A whole-card cue, unlike UNREAD_COLOR: it answers "is there anything new in
 * here?" from across the page, before you read a single title.
 */
export const UNREAD_ACCENT_BORDER = "3px solid var(--mantine-color-blue-5)"
