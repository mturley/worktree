import { afterEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { JobStepper } from "./JobStepper"
import type { JobStep } from "../../api/types"

const wrap = (steps: JobStep[]) =>
  render(<MantineProvider><JobStepper steps={steps} /></MantineProvider>)
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

  it("shows a failed step's detail", () => {
    wrap([{ key: "a", label: "First", status: "failed", detail: "fatal: could not remove" }])
    const detail = screen.getByText(/could not remove/)
    expect(detail).toBeInTheDocument()
    expect(detail).toHaveStyle({ whiteSpace: "pre-wrap" })
    expect(screen.queryByLabelText("In progress")).not.toBeInTheDocument()
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
