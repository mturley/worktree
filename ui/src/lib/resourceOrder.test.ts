import { describe, expect, it } from "vitest"
import { applyDrag } from "./resourceOrder"
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
