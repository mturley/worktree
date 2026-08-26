import { afterEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { EventDot } from "./EventDot"
import { eventMeta } from "../lib/eventMeta"

afterEach(cleanup)

describe("EventDot", () => {
  it("paints with the resolved CSS colour, not the Mantine palette name", () => {
    // A palette name like "grape" is not a valid CSS colour, and names that
    // ARE valid CSS ("violet", "indigo") resolve to a different shade — both
    // failures are invisible to the type checker.
    render(<MantineProvider><EventDot type="pr_merged" label="merged" /></MantineProvider>)
    const dot = screen.getByLabelText("merged")
    const bg = dot.style.background || dot.style.backgroundColor
    expect(bg).toBe(eventMeta("pr_merged").cssColor)
    expect(bg).toContain("var(--mantine-color-")
  })

  it("prefers an explicit label over the mapping's generic one", () => {
    render(<MantineProvider><EventDot type="pr_comment" label="PR comments" /></MantineProvider>)
    expect(screen.getByLabelText("PR comments")).toBeInTheDocument()
  })
})
