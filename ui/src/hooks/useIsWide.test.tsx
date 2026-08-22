import { afterEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import { setViewport } from "../testing/viewport"
import { useIsWide } from "./useIsWide"

function Probe() {
  return <span data-testid="probe">{useIsWide() ? "wide" : "narrow"}</span>
}

afterEach(cleanup)

describe("useIsWide", () => {
  it("reports narrow by default (matchMedia stub reports no match)", () => {
    setViewport("narrow")
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveTextContent("narrow")
  })

  it("reports wide when the viewport query matches", () => {
    setViewport("wide")
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveTextContent("wide")
  })
})
