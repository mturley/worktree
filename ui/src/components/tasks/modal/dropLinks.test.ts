import { describe, expect, it } from "vitest"
import { dropLinks } from "./LinksSection"

const g = { focus: ["a", "b", "c"], related: ["x", "y"] }
const id = (k: string) => `link:${k}`

describe("dropLinks", () => {
  it.each([
    // [name, active, over, below, want]
    ["within a group, down", "a", id("c"), false, { focus: ["b", "c", "a"], related: ["x", "y"] }],
    ["within a group, up", "c", id("a"), true, { focus: ["c", "a", "b"], related: ["x", "y"] }],
    ["across groups, above the target", "b", id("y"), false, { focus: ["a", "c"], related: ["x", "b", "y"] }],
    ["across groups, below the target", "b", id("y"), true, { focus: ["a", "c"], related: ["x", "y", "b"] }],
    ["across groups, above the first", "x", id("a"), false, { focus: ["x", "a", "b", "c"], related: ["y"] }],
    ["across groups, below the last", "x", id("c"), true, { focus: ["a", "b", "c", "x"], related: ["y"] }],
  ])("%s", (_name, active, over, below, want) => {
    expect(dropLinks(g, id(active), over, below)).toEqual(want)
  })

  it("drops onto an empty group's own droppable", () => {
    expect(dropLinks({ focus: ["a"], related: [] }, id("a"), "related", false)).toEqual({ focus: [], related: ["a"] })
    expect(dropLinks({ focus: [], related: ["x", "y"] }, id("y"), "focus", true)).toEqual({ focus: ["y"], related: ["x"] })
  })

  it("is null for a drop that changes nothing", () => {
    expect(dropLinks(g, id("b"), id("b"), false)).toBeNull() // onto itself
    expect(dropLinks(g, id("b"), id("b"), true)).toBeNull()
    expect(dropLinks(g, id("b"), "focus", false)).toBeNull() // its own group's droppable
  })

  it("is null for an unknown link or target", () => {
    expect(dropLinks(g, id("zzz"), id("a"), false)).toBeNull()
    expect(dropLinks(g, id("a"), id("zzz"), false)).toBeNull()
    expect(dropLinks(g, "focus", id("a"), false)).toBeNull()
  })

  it("leaves its input alone", () => {
    const before = JSON.stringify(g)
    dropLinks(g, id("a"), id("y"), true)
    expect(JSON.stringify(g)).toBe(before)
  })
})
