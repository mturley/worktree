import { describe, it, expect } from "vitest"
import { shortResourceRef } from "./resourceRef"

describe("shortResourceRef for links", () => {
  it("shows the domain where a PR shows its number", () => {
    expect(shortResourceRef("link", "https://developer.mozilla.org/en-US/docs/Web")).toBe("developer.mozilla.org")
  })
  it("drops a leading www.", () => {
    expect(shortResourceRef("link", "https://www.example.com/x")).toBe("example.com")
  })
  it("degrades to empty on an unparseable id rather than throwing", () => {
    expect(shortResourceRef("link", "not a url")).toBe("")
  })
})
