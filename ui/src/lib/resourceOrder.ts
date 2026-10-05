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

/** Which side of a target card, in the other group, a card lands on. */
export type Placement = "before" | "after"

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
 * lands it exactly where it was dropped: before the target, or after it when
 * `placement` says so. That differs on purpose from the
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
  placement: Placement = "before",
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
    if (moved.primary === primary) {
      // Within a group, arrayMove semantics: the card takes the target's
      // index, which is what the sortable strategy previews as it animates
      // the other cards out of the way. Placement has no say here.
      next.splice(to, 0, moved)
      return next
    }
    // Across groups, say explicitly which side of the target the card lands
    // on — whichever direction it travelled. Re-finding the target after the
    // removal is what makes that hold: removing a card from above the target
    // shifts the target's index, and inserting at the old index would land
    // the card on the wrong side of it.
    const at = indexOfKey(next, over) + (placement === "after" ? 1 : 0)
    next.splice(at, 0, { ...moved, primary })
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

/**
 * The list as it should look mid-drag, once the dragged card is over the
 * other group — or null while it is still over its own.
 *
 * Each group is its own sortable context, and a sortable only opens a slot for
 * cards that belong to its context. So a card hovering the other group gets
 * no slot until it is moved into that group's list, and this is that move.
 * Within its own group nothing needs to happen here: the sortable strategy
 * already animates the slot open.
 *
 * `activeCenterY` / `overCenterY` are the vertical centres of the dragged card
 * and the hovered one. Past the hovered card's centre, the card lands after
 * it — the only way to reach the bottom of a group.
 */
export function crossGroupPreview(
  items: ResourceDTO[],
  active: ResourceKey,
  over: DropTarget,
  activeCenterY: number,
  overCenterY: number,
): ResourceDTO[] | null {
  const moving = items[indexOfKey(items, active)]
  if (!moving) return null
  let targetPrimary: boolean
  if (isGroup(over)) {
    targetPrimary = over === "focus"
  } else {
    const target = items[indexOfKey(items, over)]
    if (!target) return null
    targetPrimary = target.primary
  }
  if (targetPrimary === moving.primary) return null
  const placement = !isGroup(over) && activeCenterY > overCenterY ? "after" : "before"
  return applyDrag(items, active, over, placement)
}
