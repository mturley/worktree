import { afterEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { JobStepper } from "./JobStepper"
import type { JobStep } from "../../api/types"

const wrap = (steps: JobStep[], quiet?: boolean) =>
  render(<MantineProvider><JobStepper steps={steps} quiet={quiet} /></MantineProvider>)
afterEach(cleanup)

describe("JobStepper", () => {
  it("shows a spinner on the running step only", () => {
    wrap([
      { key: "a", label: "First", status: "done" },
      { key: "b", label: "Second", status: "running" },
      { key: "c", label: "Third", status: "pending" },
    ])
    expect(screen.getAllByLabelText("In progress")).toHaveLength(1)
  })

  it("shows a failed step's detail, wrapping a long path anywhere", () => {
    wrap([{ key: "a", label: "First", status: "failed", detail: "fatal: could not remove" }])
    const detail = screen.getByText(/could not remove/)
    expect(detail).toBeInTheDocument()
    expect(detail).toHaveStyle({ whiteSpace: "pre-wrap", overflowWrap: "anywhere" })
    expect(screen.queryByLabelText("In progress")).not.toBeInTheDocument()
  })

  // A job that ended out of sight has steps that still say "running"; nothing
  // about it is still happening, so nothing spins.
  it("quiet drops the spinner from a step left mid-flight", () => {
    wrap([
      { key: "a", label: "First", status: "done" },
      { key: "b", label: "Second", status: "running" },
    ], true)
    expect(screen.queryByLabelText("In progress")).not.toBeInTheDocument()
    expect(screen.getByText("Second").getAttribute("style")).toContain("dimmed")
  })

  it("dims pending steps", () => {
    wrap([{ key: "a", label: "Later", status: "pending" }])
    expect(screen.getByText("Later").getAttribute("style")).toContain("dimmed")
    expect(screen.getByText("○")).toBeInTheDocument()
  })

  it("shows a skipped step's detail in parentheses", () => {
    wrap([{ key: "a", label: "Delete branch", status: "skipped", detail: "kept" }])
    expect(screen.getByText("(kept)")).toBeInTheDocument()
  })
})
