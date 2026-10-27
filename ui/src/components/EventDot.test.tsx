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
    render(<MantineProvider><EventDot type="pr_merged" /></MantineProvider>)
    const dot = screen.getByLabelText("Merged")
    const bg = dot.style.background || dot.style.backgroundColor
    expect(bg).toBe(eventMeta("pr_merged").cssColor)
    expect(bg).toContain("var(--mantine-color-")
  })

  it("draws a task event's state checkbox inside the usual circle, in place of the icon", () => {
    render(<MantineProvider><EventDot type="task_state_changed" label="State changed" taskState="done" /></MantineProvider>)
    const dot = screen.getByLabelText("State changed")
    expect(dot).toHaveAttribute("data-task-state", "done")
    expect(dot.style.borderRadius).toBe("50%")
    expect(dot.style.background || dot.style.backgroundColor).toBe(eventMeta("task_state_changed").cssColor)
    expect(dot.querySelector("[data-state-box]")).toHaveAttribute("data-state", "done")
    expect(dot.querySelector("svg")).toBeNull()
  })

  it("prefers an explicit label over the mapping's generic one", () => {
    render(<MantineProvider><EventDot type="pr_comment" label="PR comments" /></MantineProvider>)
    expect(screen.getByLabelText("PR comments")).toBeInTheDocument()
  })

  it("capitalises the label, leaving already-capitalised ones alone", () => {
    const { unmount } = render(<MantineProvider><EventDot type="pr_merged" /></MantineProvider>)
    expect(screen.getByLabelText("Merged")).toBeInTheDocument()
    unmount()
    render(<MantineProvider><EventDot type="ci_check_failed" /></MantineProvider>)
    expect(screen.getByLabelText("CI failed")).toBeInTheDocument()
  })

  it("mixes its colour toward the background when dimmed", () => {
    render(<MantineProvider><EventDot type="pr_merged" dimmed /></MantineProvider>)
    const dot = screen.getByLabelText("Merged")
    const bg = dot.style.background || dot.style.backgroundColor
    expect(bg).toContain("color-mix")
    expect(bg).toContain(eventMeta("pr_merged").cssColor)
  })
})

describe("EventDot for a task event", () => {
  it("paints with the task accent variable", () => {
    render(<MantineProvider><EventDot type="subtask_checked" /></MantineProvider>)
    const dot = screen.getByLabelText("Subtask checked")
    expect(dot.style.background || dot.style.backgroundColor).toBe("var(--task-accent)")
  })

  it("dims the accent like any other colour", () => {
    render(<MantineProvider><EventDot type="task_created" dimmed /></MantineProvider>)
    const dot = screen.getByLabelText("Created")
    expect(dot.style.background).toContain("color-mix")
    expect(dot.style.background).toContain("var(--task-accent)")
  })
})
