import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fileAnchorId } from "./parsedPatch"
import { DIFF_SCROLLER_CLASS, scrollToFile } from "./scrollToFile"

// Frames run only when the test says so, each one 16ms after the last.
let frames: FrameRequestCallback[] = []
let now = 0
const runFrames = (n: number) => {
  for (let i = 0; i < n; i++) {
    now += 16
    const due = frames
    frames = []
    due.forEach((cb) => cb(0))
  }
}

let scroller: HTMLElement
const SCROLLER_TOP = 100

/** A scroller whose rect is fixed, and a file whose rect follows scrollTop. */
function mount() {
  scroller = document.createElement("div")
  scroller.className = DIFF_SCROLLER_CLASS
  Object.defineProperty(scroller, "scrollHeight", { value: 10_000, configurable: true })
  Object.defineProperty(scroller, "clientHeight", { value: 600 })
  scroller.getBoundingClientRect = () => ({ top: SCROLLER_TOP }) as DOMRect
  document.body.appendChild(scroller)
}
function addFile(path: string, offset: () => number) {
  const el = document.createElement("div")
  el.id = fileAnchorId(path)
  el.getBoundingClientRect = () => ({ top: SCROLLER_TOP + offset() - scroller.scrollTop }) as DOMRect
  scroller.appendChild(el)
  return el
}

beforeEach(() => {
  frames = []
  now = 0
  vi.spyOn(performance, "now").mockImplementation(() => now)
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (frames.push(cb), frames.length))
  vi.stubGlobal("cancelAnimationFrame", () => {})
  Element.prototype.scrollIntoView = vi.fn()
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
  window.scrollBy = vi.fn() as unknown as typeof window.scrollBy
  mount()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

describe("scrollToFile", () => {
  it("scrolls only the diff scroller, never the document", () => {
    addFile("b.go", () => 700)
    scrollToFile("b.go")
    runFrames(10)
    expect(scroller.scrollTop).toBe(700)
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
    expect(window.scrollTo).not.toHaveBeenCalled()
    expect(window.scrollBy).not.toHaveBeenCalled()
  })

  it("waits for a file that isn't rendered yet", () => {
    scrollToFile("b.go")
    runFrames(5)
    addFile("b.go", () => 300)
    runFrames(10)
    expect(scroller.scrollTop).toBe(300)
  })

  it("follows the file when the files above it grow after the first jump", () => {
    let offset = 300
    addFile("b.go", () => offset)
    scrollToFile("b.go")
    runFrames(2)
    expect(scroller.scrollTop).toBe(300)
    offset = 900 // pierre measured the files above
    runFrames(10)
    expect(scroller.scrollTop).toBe(900)
  })

  it("stops when the reader scrolls", () => {
    let offset = 300
    addFile("b.go", () => offset)
    scrollToFile("b.go")
    runFrames(1)
    scroller.dispatchEvent(new Event("wheel"))
    offset = 900
    runFrames(10)
    expect(scroller.scrollTop).toBe(300)
  })

  // The browser-verified landing bug: right after entry nothing above the
  // target has been measured, so the scroller is exactly as tall as its
  // content (not scrollable) and the target sits a few pixels down. That
  // looks like "can go no further", and used to be taken as done.
  it("keeps going while the scroller is not yet scrollable, and lands once the content grows", () => {
    let content = 600 // == clientHeight: nothing to scroll yet
    let top = 0
    Object.defineProperty(scroller, "scrollHeight", { get: () => content })
    Object.defineProperty(scroller, "scrollTop", {
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(v, content - 600))
      },
    })
    let offset = 12
    addFile("b.go", () => offset)
    scrollToFile("b.go")
    runFrames(30) // ~0.5s of the files above still at no height
    expect(scroller.scrollTop).toBe(0)
    content = 190_000 // pierre measured everything
    offset = 25_000
    runFrames(10)
    expect(scroller.scrollTop).toBe(25_000)
  })

  it("keeps listening for the reader through keyboard scrolling", () => {
    let offset = 300
    addFile("b.go", () => offset)
    scrollToFile("b.go")
    runFrames(1)
    scroller.dispatchEvent(new Event("keydown"))
    offset = 900
    runFrames(10)
    expect(scroller.scrollTop).toBe(300)
  })

  it("can be cancelled, and gives up after a bounded time", () => {
    const cancel = scrollToFile("missing.go")
    runFrames(3)
    cancel()
    runFrames(1) // a frame already queued finds it cancelled and queues no more
    expect(frames).toHaveLength(0)
    scrollToFile("never.go")
    runFrames(200) // 3.2s: still waiting
    expect(frames).toHaveLength(1)
    runFrames(100) // past the 4s bound
    expect(frames).toHaveLength(0)
  })
})
