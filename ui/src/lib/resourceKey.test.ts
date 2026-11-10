import { describe, it, expect } from "vitest"
import { serializeResourceKey, parseResourceKey, resourceKeyEquals, resourceParam } from "./resourceKey"

describe("resourceKey", () => {
  it("round-trips a PR id containing / and #", () => {
    const key = { type: "pr", id: "org/repo#1" }
    expect(parseResourceKey(serializeResourceKey(key))).toEqual(key)
  })

  it("round-trips a Slack id that itself contains a colon", () => {
    const key = { type: "slack", id: "C123:1700000000.000100" }
    const raw = serializeResourceKey(key)
    expect(parseResourceKey(raw)).toEqual(key)
  })

  it("resourceParam encodes the same way URLSearchParams.set does", () => {
    const key = { type: "link", id: "https://ci.example/a%20b/c?x=1&y=2" }
    const p = new URLSearchParams(resourceParam(key))
    expect(parseResourceKey(p.get("resource"))).toEqual(key)
    const viaSet = new URLSearchParams()
    viaSet.set("resource", serializeResourceKey(key))
    expect(parseResourceKey(new URLSearchParams(viaSet.toString()).get("resource"))).toEqual(key)
  })

  it("splits on the first colon only", () => {
    // Even unencoded, everything after the first colon is the id.
    expect(parseResourceKey("slack:C1:2.3")).toEqual({ type: "slack", id: "C1:2.3" })
  })

  it("falls back to the raw remainder for malformed percent-encoding, without throwing", () => {
    expect(() => parseResourceKey("slack:%zz")).not.toThrow()
    expect(parseResourceKey("slack:%zz")).toEqual({ type: "slack", id: "%zz" })
  })

  it("returns null for empty, missing, or malformed input", () => {
    expect(parseResourceKey(null)).toBeNull()
    expect(parseResourceKey(undefined)).toBeNull()
    expect(parseResourceKey("")).toBeNull()
    expect(parseResourceKey("noseparator")).toBeNull()
    expect(parseResourceKey(":missingtype")).toBeNull()
    expect(parseResourceKey("missingid:")).toBeNull()
  })

  it("compares keys structurally, treating nulls as unequal to keys", () => {
    expect(resourceKeyEquals({ type: "pr", id: "a" }, { type: "pr", id: "a" })).toBe(true)
    expect(resourceKeyEquals({ type: "pr", id: "a" }, { type: "jira", id: "a" })).toBe(false)
    expect(resourceKeyEquals(null, null)).toBe(true)
    expect(resourceKeyEquals(null, { type: "pr", id: "a" })).toBe(false)
  })
})
