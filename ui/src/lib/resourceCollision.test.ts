import { describe, expect, it } from "vitest"
import type { ClientRect, CollisionDetection, DroppableContainer } from "@dnd-kit/core"
import { resourceCollisions } from "./resourceCollision"

type Args = Parameters<CollisionDetection>[0]

function rect(top: number, height: number): ClientRect {
  return { top, height, left: 0, width: 200, right: 200, bottom: top + height }
}

// A focus group holding cards a and b, and a related group below it.
function layout(rects: Record<string, ClientRect>, pointerY: number, collisionTop: number): Args {
  const ids = Object.keys(rects)
  return {
    active: { id: "pr:a" } as Args["active"],
    collisionRect: rect(collisionTop, 40),
    droppableRects: new Map(ids.map((id) => [id, rects[id]])),
    droppableContainers: ids.map((id) => ({ id, disabled: false }) as unknown as DroppableContainer),
    pointerCoordinates: { x: 100, y: pointerY },
  }
}

describe("resourceCollisions", () => {
  it("aims at the nearest card rather than at the group container around it", () => {
    // The focus container spans both cards, so its centre sits between them
    // and can out-score either card for closestCenter. Aiming at it would
    // leave the drop with no card to land next to.
    // Dragged card centred at y=50: exactly the container's centre, and 30px
    // from either card's.
    const args = layout(
      { focus: rect(0, 100), "pr:a": rect(0, 40), "pr:b": rect(60, 40) },
      50,
      30,
    )
    const hits = resourceCollisions(() => false)(args)
    expect(hits[0]?.id).not.toBe("focus")
    expect(["pr:a", "pr:b"]).toContain(hits[0]?.id)
  })

  it("lands on an empty group, which has no card to aim at", () => {
    const args = layout(
      { focus: rect(0, 100), "pr:a": rect(0, 40), "pr:b": rect(60, 40), related: rect(140, 36) },
      150,
      140,
    )
    const hits = resourceCollisions((g) => g === "related")(args)
    expect(hits[0]?.id).toBe("related")
  })

  it("still aims at cards inside a group that is not empty", () => {
    const args = layout(
      { focus: rect(0, 100), "pr:a": rect(0, 40), "pr:b": rect(60, 40) },
      10,
      0,
    )
    const hits = resourceCollisions(() => false)(args)
    expect(hits[0]?.id).toBe("pr:a")
  })
})
