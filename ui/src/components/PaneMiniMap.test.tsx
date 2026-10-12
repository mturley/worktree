import { afterEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import type { CmuxLayout } from "../api/types"
import { PaneMiniMap } from "./PaneMiniMap"

afterEach(cleanup)

// pane:1 | (pane:2 over pane:3)
const layout: CmuxLayout = {
  direction: "horizontal",
  split: 0.6,
  children: [
    { pane: "pane:1" },
    { direction: "vertical", split: 0.5, children: [{ pane: "pane:2" }, { pane: "pane:3" }] },
  ],
}

describe("PaneMiniMap", () => {
  it("draws every pane and highlights only the target", () => {
    const { container } = render(<PaneMiniMap layout={layout} highlight="pane:3" />)
    expect(screen.getByRole("img", { name: "Workspace pane layout" })).toBeInTheDocument()
    const panes = [...container.querySelectorAll("[data-pane]")].map((el) => el.getAttribute("data-pane"))
    expect(panes).toEqual(["pane:1", "pane:2", "pane:3"])
    const lit = [...container.querySelectorAll("[data-highlighted]")].map((el) => el.getAttribute("data-pane"))
    expect(lit).toEqual(["pane:3"])
  })

  it("sizes splits by cmux's ratio and nests their direction", () => {
    const { container } = render(<PaneMiniMap layout={layout} highlight="pane:1" />)
    const outer = container.querySelector('[data-split="horizontal"]') as HTMLElement
    expect(outer.style.flexDirection).toBe("row")
    expect((outer.children[0] as HTMLElement).style.flex).toMatch(/^0\.6 1 0/)
    expect((container.querySelector('[data-split="vertical"]') as HTMLElement).style.flexDirection).toBe("column")
  })

  it("draws a single-pane workspace as one highlighted box", () => {
    const { container } = render(<PaneMiniMap layout={{ pane: "pane:1" }} highlight="pane:1" />)
    expect(container.querySelectorAll("[data-pane]")).toHaveLength(1)
    expect(container.querySelector("[data-highlighted]")).not.toBeNull()
  })
})
