import { describe, expect, it } from "vitest"
import { toggleTaskAt } from "./taskList"

describe("toggleTaskAt", () => {
  const src = "intro\n\n- [ ] one\n  - [x] nested\n> * [ ] quoted\n\n1. [X] numbered\n+ [ ] plus\n"
  const at = (needle: string) => src.indexOf(needle)

  it("checks an unchecked item, changing only its marker", () => {
    expect(toggleTaskAt(src, at("- [ ] one"))).toBe(src.replace("- [ ] one", "- [x] one"))
  })

  it("unchecks a checked item, lower or upper case", () => {
    expect(toggleTaskAt(src, at("- [x] nested"))).toBe(src.replace("- [x] nested", "- [ ] nested"))
    expect(toggleTaskAt(src, at("1. [X] numbered"))).toBe(src.replace("1. [X] numbered", "1. [ ] numbered"))
  })

  it("handles every bullet style", () => {
    expect(toggleTaskAt(src, at("* [ ] quoted"))).toBe(src.replace("* [ ] quoted", "* [x] quoted"))
    expect(toggleTaskAt(src, at("+ [ ] plus"))).toBe(src.replace("+ [ ] plus", "+ [x] plus"))
  })

  it("refuses an offset that is not at a task item, rather than guessing", () => {
    expect(toggleTaskAt(src, 0)).toBeNull()
    expect(toggleTaskAt(src, at("[ ] one"))).toBeNull()
    expect(toggleTaskAt(src, -1)).toBeNull()
    expect(toggleTaskAt(src, src.length + 5)).toBeNull()
    expect(toggleTaskAt("- plain item", 0)).toBeNull()
  })
})
