import type { ResourceDTO } from "../api/types"
import type { ResourceKey } from "./resourceKey"

/** The two drop targets that are groups rather than cards. */
export type GroupId = "focus" | "related"

/**
 * A drop target: another card, or a group container. Dropping on a container
 * is how a card reaches a group that is currently empty — there is no card
 * there to aim at.
 */
export type DropTarget = ResourceKey | GroupId

function isGroup(t: DropTarget): t is GroupId {
  return t === "focus" || t === "related"
}

function indexOfKey(items: ResourceDTO[], key: ResourceKey): number {
  return items.findIndex((r) => r.type === key.type && r.id === key.id)
}

/**
 * Applies one drag to the flat, group-ordered resource list and returns a new
 * list. Focus cards come first, related after, so "which group a card is in"
 * and "where it sits in the list" stay the same fact — which is what lets a
 * single flat array describe a drag across the group boundary.
 *
 * Dropping onto a card in the other group reclassifies the dragged card and
 * lands it exactly where it was dropped. That differs on purpose from the
 * focus/related toggle, which sends a card to the bottom of its new group: a
 * drag states a position, a toggle does not.
 *
 * Unknown keys and self-drops return the list unchanged, so a stale render or
 * a stray drag event is a no-op rather than a scramble.
 */
export function applyDrag(
  items: ResourceDTO[],
  active: ResourceKey,
  over: DropTarget,
): ResourceDTO[] {
  const from = indexOfKey(items, active)
  if (from < 0) return items

  if (!isGroup(over)) {
    if (over.type === active.type && over.id === active.id) return items
    const to = indexOfKey(items, over)
    if (to < 0) return items
    const primary = items[to].primary
    const next = items.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, { ...moved, primary })
    return next
  }

  const primary = over === "focus"
  const next = items.slice()
  const [moved] = next.splice(from, 1)
  // Past the last card already in the target group. With the group empty
  // there is nothing to sit after, so fall back to the edge of the list that
  // group occupies: focus at the top, related at the bottom.
  const last = next.map((r) => r.primary).lastIndexOf(primary)
  const to = last >= 0 ? last + 1 : primary ? 0 : next.length
  next.splice(to, 0, { ...moved, primary })
  return next
}
