import { describe, expect, it } from "vitest"
import { applyDrag, crossGroupPreview } from "./resourceOrder"
import type { ResourceDTO } from "../api/types"

function r(id: string, primary: boolean): ResourceDTO {
  return { type: "pr", id, url: "u", primary }
}

const items = [r("1", true), r("2", true), r("3", true), r("8", false), r("9", false)]

function shape(next: ResourceDTO[]): string {
  return next.map((x) => `${x.id}${x.primary ? "" : "~"}`).join(",")
}

describe("applyDrag", () => {
  it("moves a card down within its own group", () => {
    const next = applyDrag(items, { type: "pr", id: "1" }, { type: "pr", id: "3" })
    expect(shape(next)).toBe("2,3,1,8~,9~")
  })

  it("moves a card up within its own group", () => {
    const next = applyDrag(items, { type: "pr", id: "3" }, { type: "pr", id: "1" })
    expect(shape(next)).toBe("3,1,2,8~,9~")
  })

  it("reclassifies a card dropped onto a card in the other group", () => {
    const next = applyDrag(items, { type: "pr", id: "9" }, { type: "pr", id: "2" })
    expect(shape(next)).toBe("1,9,2,3,8~")
  })

  it("places a card moving down into the other group before its target by default", () => {
    // Cross-group moves are explicit about which side of the target the card
    // lands on, whichever direction it travels. (Within a group, arrayMove
    // semantics still apply: see the two cases above.)
    const next = applyDrag(items, { type: "pr", id: "1" }, { type: "pr", id: "8" })
    expect(shape(next)).toBe("2,3,1~,8~,9~")
  })

  it("places a card after its target in the other group when asked", () => {
    // How a card reaches the bottom of the other group: hover the lower half
    // of its last card.
    const next = applyDrag(items, { type: "pr", id: "1" }, { type: "pr", id: "9" }, "after")
    expect(shape(next)).toBe("2,3,8~,9~,1~")
  })

  it("places a card moving up into the other group after its target when asked", () => {
    const next = applyDrag(items, { type: "pr", id: "9" }, { type: "pr", id: "3" }, "after")
    expect(shape(next)).toBe("1,2,3,9,8~")
  })

  it("ignores placement within a group, where the sortable strategy decides", () => {
    const next = applyDrag(items, { type: "pr", id: "1" }, { type: "pr", id: "3" }, "after")
    expect(shape(next)).toBe("2,3,1,8~,9~")
  })

  it("moves a card into an empty group when dropped on the group itself", () => {
    const focusOnly = [r("1", true), r("2", true)]
    const next = applyDrag(focusOnly, { type: "pr", id: "2" }, "related")
    expect(shape(next)).toBe("1,2~")
  })

  it("appends to the end when dropped on a non-empty group container", () => {
    const next = applyDrag(items, { type: "pr", id: "1" }, "related")
    expect(shape(next)).toBe("2,3,8~,9~,1~")
  })

  it("returns the list untouched when a card is dropped on itself", () => {
    const next = applyDrag(items, { type: "pr", id: "2" }, { type: "pr", id: "2" })
    expect(shape(next)).toBe("1,2,3,8~,9~")
  })

  it("returns the list untouched for a key it does not know", () => {
    const next = applyDrag(items, { type: "pr", id: "404" }, { type: "pr", id: "1" })
    expect(shape(next)).toBe("1,2,3,8~,9~")
  })
})

describe("crossGroupPreview", () => {
  // Centres are y-coordinates: the dragged card's, and the hovered card's.
  it("does nothing while the card is still over its own group", () => {
    expect(crossGroupPreview(items, { type: "pr", id: "1" }, { type: "pr", id: "3" }, 0, 0)).toBeNull()
  })

  it("moves the card into the other group, before a card it is above", () => {
    const next = crossGroupPreview(items, { type: "pr", id: "1" }, { type: "pr", id: "9" }, 90, 100)
    expect(next && shape(next)).toBe("2,3,8~,1~,9~")
  })

  it("moves the card into the other group, after a card it is below", () => {
    // The only way to reach the bottom of a group is past its last card.
    const next = crossGroupPreview(items, { type: "pr", id: "1" }, { type: "pr", id: "9" }, 110, 100)
    expect(next && shape(next)).toBe("2,3,8~,9~,1~")
  })

  it("moves the card into an empty group hovered as a whole", () => {
    const focusOnly = [r("1", true), r("2", true)]
    const next = crossGroupPreview(focusOnly, { type: "pr", id: "2" }, "related", 0, 0)
    expect(next && shape(next)).toBe("1,2~")
  })

  it("does nothing for a key it does not know", () => {
    expect(crossGroupPreview(items, { type: "pr", id: "404" }, { type: "pr", id: "9" }, 0, 0)).toBeNull()
  })
})
