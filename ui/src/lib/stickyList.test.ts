import { describe, expect, it } from "vitest"
import { stickyListStyle } from "./stickyList"

describe("stickyListStyle", () => {
  it("sticks half a gutter below the header, where the column already rests", () => {
    // The shell's Stack puts a full `md` below the header, and Mantine's Grid
    // pulls its inner back up by half a gutter, so the column's resting top is
    // headerHeight + md/2. Sticking at bare headerHeight would leave that
    // half-gutter as scroll travel: the list would creep upwards for the first
    // few pixels of page scroll and eat the gap above its first element.
    expect(stickyListStyle(64).top).toBe("calc(64px + var(--mantine-spacing-md) / 2)")
  })

  it("ends the stuck column at the bottom of the viewport, not past it", () => {
    // maxHeight has to complement top exactly. Change one without the other
    // and the column either runs off the bottom of the screen or stops short
    // of it, and the list's own scrollbar goes with it.
    const { top, maxHeight } = stickyListStyle(64)
    // CSSProperties types these as string | number, so normalise before
    // comparing the two expressions against each other.
    const offset = String(top).replace(/^calc\(/, "").replace(/\)$/, "")
    expect(String(maxHeight)).toBe(`calc(100dvh - (${offset}))`)
  })

  it("tracks a header that changes height", () => {
    expect(stickyListStyle(120).top).toBe("calc(120px + var(--mantine-spacing-md) / 2)")
  })
})
