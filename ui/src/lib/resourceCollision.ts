import {
  closestCenter,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
} from "@dnd-kit/core"
import type { GroupId } from "./resourceOrder"

function isGroupId(id: unknown): id is GroupId {
  return id === "focus" || id === "related"
}

/**
 * Collision detection for the resource list's two groups.
 *
 * The groups are droppables as well as the cards inside them, so that a card
 * can be dropped into an empty group. Left to closestCenter, though, a group
 * container competes with its own cards: it spans them, so its centre sits
 * among them and can win, leaving the drop aimed at a group rather than at a
 * position in it. So:
 *
 * - an EMPTY group under the pointer wins outright — there is no card in it
 *   to aim at;
 * - otherwise group containers are ignored, and the nearest card wins.
 *
 * `isEmptyGroup` is asked rather than inferred from rects because an empty
 * group's drop zone is a placeholder with a height of its own.
 */
export function resourceCollisions(isEmptyGroup: (group: GroupId) => boolean): CollisionDetection {
  return (args) => {
    const underPointer = pointerWithin(args)
    const hits = underPointer.length > 0 ? underPointer : rectIntersection(args)
    const empty = hits.find((h) => isGroupId(h.id) && isEmptyGroup(h.id))
    if (empty) return [empty]
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => !isGroupId(c.id)),
    })
  }
}
