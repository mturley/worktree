import { describe, expect, it } from "vitest"
import { startsRowDrag } from "./taskDrag"

function row() {
  const el = document.createElement("div")
  el.innerHTML = `
    <div data-task-row>
      <span><button data-task-grip>grip</button></span>
      <button class="task-row-control" data-checkbox>state</button>
      <button><span data-title>the task's title</span></button>
      <button class="task-link-chip-nav" data-chip>chip</button>
    </div>`
  const q = (sel: string) => el.querySelector(sel)!
  return { el, grip: q("[data-task-grip]"), checkbox: q("[data-checkbox]"), title: q("[data-title]"), chip: q("[data-chip]") }
}

describe("startsRowDrag", () => {
  it("anywhere: starts on the grip, the title (a button) or the row itself, not on a control", () => {
    const r = row()
    expect(startsRowDrag(r.grip, r.el, true)).toBe(true)
    expect(startsRowDrag(r.title, r.el, true)).toBe(true)
    expect(startsRowDrag(r.el.firstElementChild, r.el, true)).toBe(true)
    expect(startsRowDrag(r.checkbox, r.el, true)).toBe(false)
    expect(startsRowDrag(r.chip, r.el, true)).toBe(false)
  })

  it("grip only: starts on the grip alone", () => {
    const r = row()
    expect(startsRowDrag(r.grip, r.el, false)).toBe(true)
    expect(startsRowDrag(r.title, r.el, false)).toBe(false)
  })

  it("never from outside the row's DOM, as a portalled menu's bubbled event is", () => {
    const r = row()
    const portalled = document.createElement("div")
    expect(startsRowDrag(portalled, r.el, true)).toBe(false)
    expect(startsRowDrag(null, r.el, true)).toBe(false)
  })
})
