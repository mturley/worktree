import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { TOOLTIP_Z_VAR, useTooltipLayer } from "./useTooltipLayer"

function Page() {
  useTooltipLayer()
  return (
    <>
      <button>outside</button>
      <div data-tooltip-layer="content">
        <div data-tooltip-layer="pinned" data-testid="pinned">
          <button>in pinned</button>
        </div>
        <div data-testid="feed">
          <button>in content</button>
        </div>
      </div>
    </>
  )
}

const z = () => document.documentElement.style.getPropertyValue(TOOLTIP_Z_VAR)
const UNDER = "calc(var(--mantine-z-index-app) - 2)"
const OVER = "calc(var(--mantine-z-index-app) - 1)"

function rect(el: HTMLElement, top: number, height: number) {
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
}

/** The header at 0-50, and the feed after it scrolled up by `scrolled`. */
function layout(scrolled: number) {
  rect(screen.getByTestId("pinned"), 0, 50)
  rect(screen.getByTestId("feed"), 50 - scrolled, 500)
}

afterEach(cleanup)

describe("useTooltipLayer", () => {
  it("drops tooltips below a pinned header while it is stuck over scrolled content", () => {
    render(<Page />)
    layout(30)
    fireEvent.pointerOver(screen.getByText("in content"))
    expect(z()).toBe(UNDER)
  })

  it("keeps content tooltips above a pinned header that is not stuck (scrolled to the top)", () => {
    render(<Page />)
    layout(0)
    fireEvent.pointerOver(screen.getByText("in content"))
    expect(z()).toBe(OVER)
  })

  it("re-layers an open tooltip as its scroller scrolls the header into and out of being stuck", () => {
    render(<Page />)
    layout(0)
    fireEvent.pointerOver(screen.getByText("in content"))
    expect(z()).toBe(OVER)
    layout(30)
    fireEvent.scroll(document)
    expect(z()).toBe(UNDER)
    layout(0)
    fireEvent.scroll(screen.getByTestId("feed"))
    expect(z()).toBe(OVER)
  })

  it("keeps the usual layer inside a pinned block, and outside any content", () => {
    render(<Page />)
    layout(30)
    fireEvent.pointerOver(screen.getByText("in content"))
    fireEvent.pointerOver(screen.getByText("in pinned"))
    expect(z()).toBe("")
    fireEvent.pointerOver(screen.getByText("in content"))
    fireEvent.pointerOver(screen.getByText("outside"))
    expect(z()).toBe("")
    fireEvent.scroll(window)
    expect(z()).toBe("")
  })

  it("follows keyboard focus too", () => {
    render(<Page />)
    layout(30)
    fireEvent.focusIn(screen.getByText("in content"))
    expect(z()).toBe(UNDER)
  })

  it("clears the variable on unmount", () => {
    const view = render(<Page />)
    layout(30)
    fireEvent.pointerOver(screen.getByText("in content"))
    view.unmount()
    expect(z()).toBe("")
  })
})
