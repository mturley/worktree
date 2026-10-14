import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { TOOLTIP_Z_VAR, useTooltipLayer } from "./useTooltipLayer"

function Page() {
  useTooltipLayer()
  return (
    <>
      <button>outside</button>
      <div data-tooltip-layer="content">
        <button>in content</button>
        <div data-tooltip-layer="pinned">
          <button>in pinned</button>
        </div>
      </div>
    </>
  )
}

const z = () => document.documentElement.style.getPropertyValue(TOOLTIP_Z_VAR)

afterEach(cleanup)

describe("useTooltipLayer", () => {
  it("drops tooltips below pinned blocks for anchors in scrolling content", () => {
    render(<Page />)
    fireEvent.pointerOver(screen.getByText("in content"))
    expect(z()).toBe("calc(var(--mantine-z-index-app) - 2)")
  })

  it("keeps the usual layer inside a pinned block, and outside any content", () => {
    render(<Page />)
    fireEvent.pointerOver(screen.getByText("in content"))
    fireEvent.pointerOver(screen.getByText("in pinned"))
    expect(z()).toBe("")
    fireEvent.pointerOver(screen.getByText("in content"))
    fireEvent.pointerOver(screen.getByText("outside"))
    expect(z()).toBe("")
  })

  it("follows keyboard focus too", () => {
    render(<Page />)
    fireEvent.focusIn(screen.getByText("in content"))
    expect(z()).not.toBe("")
  })

  it("clears the variable on unmount", () => {
    const view = render(<Page />)
    fireEvent.pointerOver(screen.getByText("in content"))
    view.unmount()
    expect(z()).toBe("")
  })
})
