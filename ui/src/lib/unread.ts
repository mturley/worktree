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
 * The wash behind an unread timeline event.
 *
 * Events only. Cards say it with their left bar alone — a tint there competed
 * with the resource card's selection tint for the same surface.
 */
export const UNREAD_BG = "color-mix(in srgb, var(--mantine-color-blue-filled) 10%, transparent)"

/**
 * The box drawn around an unread timeline event, and the invisible one every
 * other row carries.
 *
 * They MUST stay the same width: a border that appears only when unread would
 * shift the row's text and make the feed look ragged. The width is exported
 * because the timeline rail has to reserve it too — see timelineRail.ts.
 *
 * They are also complete `border` values rather than a shared shorthand plus a
 * conditional `borderColor`, which is a bug, not a style preference. Setting
 * both drops the shorthand from the CSSOM, so clearing the colour on mark-read
 * left the width and style behind with `border-color` falling back to
 * `currentColor` — a white box that survived until reload.
 *
 * Used by timeline events and by the cards, which pair it with
 * UNREAD_ACCENT_BORDER on their left edge.
 */
export const UNREAD_BORDER_WIDTH = 2
export const UNREAD_BOX_BORDER = `${UNREAD_BORDER_WIDTH}px solid var(--mantine-color-blue-5)`
export const READ_BOX_BORDER = `${UNREAD_BORDER_WIDTH}px solid transparent`


/**
 * The heavier left edge a card grows when something inside it is unread,
 * inside the UNREAD_BOX_BORDER that rings the rest of it.
 *
 * Cards carry both because they are objects with edges of their own: the box
 * says "this one", the thicker bar survives being scanned down a column of
 * them. Deliberately no background — the resource card spends its background
 * on SELECTION, and one surface cannot carry two washes.
 */
export const UNREAD_ACCENT_BORDER = "5px solid var(--mantine-color-blue-5)"

/**
 * A card's four border sides, for every combination of unread and selected.
 *
 * ALWAYS all four, ALWAYS complete values, and NEVER `borderColor` — that
 * combination is a bug, not a style, and it has now caused two of them:
 *
 *   - `border` shorthand + conditional `borderColor` left a white box behind
 *     on mark-read, the colour falling back to currentColor.
 *   - side shorthands + `borderColor` for selection meant deselecting an
 *     unread card stripped the colour from all four sides at once, dropping
 *     it to the stylesheet's grey.
 *
 * Neither reproduced in jsdom, whose CSSOM resolves shorthand conflicts
 * differently from a browser's. So the invariant this function exists to hold
 * is the thing worth testing — that no card ever emits `borderColor` beside a
 * side border — rather than the resulting colours.
 *
 * Unread wins the border outright; selection owns the background instead.
 * They are orthogonal, so a card can show both without either one having to
 * give something up.
 */
export function cardEdgeStyle(unread: boolean, selected = false): {
  borderTop: string
  borderRight: string
  borderBottom: string
  borderLeft: string
} {
  const side = unread ? UNREAD_BOX_BORDER : selected ? SELECTED_BORDER : READ_CARD_BORDER
  return {
    borderTop: side,
    borderRight: side,
    borderBottom: side,
    borderLeft: unread ? UNREAD_ACCENT_BORDER : side,
  }
}

/** Selection's border. Violet so it never reads as unread blue. */
export const SELECTED_BORDER = "1px solid var(--mantine-color-violet-filled)"

/**
 * A resting card's border — what Mantine's `withBorder` would draw. Emitted
 * explicitly rather than left to Paper so that the read state is a VALUE and
 * not the absence of one: removing a border property is what let the browser
 * fall back somewhere unintended.
 */
export const READ_CARD_BORDER = "1px solid var(--mantine-color-default-border)"
