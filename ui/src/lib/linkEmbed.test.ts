import { describe, it, expect } from "vitest"
import { canEmbed } from "./linkEmbed"

describe("canEmbed", () => {
  it("embeds a page whose headers permit it", () => {
    expect(canEmbed("https://ex.com/a", true, "http://127.0.0.1:8475")).toBe(true)
  })
  it("refuses a page whose headers forbid it", () => {
    expect(canEmbed("https://ex.com/a", false, "http://127.0.0.1:8475")).toBe(false)
  })
  it("refuses when embeddability is unknown", () => {
    expect(canEmbed("https://ex.com/a", undefined, "http://127.0.0.1:8475")).toBe(false)
  })
  it("REFUSES OUR OWN ORIGIN even when embeddable says yes", () => {
    // This is the rule that makes sandbox allow-same-origin safe: that flag
    // only permits a sandbox escape when the frame is same-origin with its
    // embedder, and this is what guarantees it never is.
    expect(canEmbed("http://127.0.0.1:8475/worktree/x", true, "http://127.0.0.1:8475")).toBe(false)
  })
  it("refuses an unparseable url", () => {
    expect(canEmbed("not a url", true, "http://127.0.0.1:8475")).toBe(false)
  })
})
