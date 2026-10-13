import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, fireEvent } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { EventTypeFilter } from "./EventTypeFilter"

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)
afterEach(cleanup)

describe("EventTypeFilter", () => {
  it("renders nothing until a single source is selected", () => {
    wrap(<EventTypeFilter sources={[]} value={[]} onChange={vi.fn()} />)
    expect(screen.queryByTestId("event-type-filter")).toBeNull()
  })

  it("renders nothing for Slack, which has one kind of event", () => {
    wrap(<EventTypeFilter sources={["slack"]} value={[]} onChange={vi.fn()} />)
    expect(screen.queryByTestId("event-type-filter")).toBeNull()
  })

  it("offers the selected source's categories", () => {
    wrap(<EventTypeFilter sources={["jira"]} value={[]} onChange={vi.fn()} />)
    for (const name of ["Comments", "Status", "Assignee", "Edits"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument()
    }
    expect(screen.queryByRole("button", { name: "CI" })).toBeNull()
  })

  it("adds to the selection rather than replacing it", () => {
    const onChange = vi.fn()
    wrap(<EventTypeFilter sources={["pr"]} value={["comments"]} onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: "CI" }))
    expect(onChange).toHaveBeenCalledWith(["comments", "ci"])
  })

  it("removes an active category on a second click", () => {
    const onChange = vi.fn()
    wrap(<EventTypeFilter sources={["pr"]} value={["comments", "ci"]} onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Comments" }))
    expect(onChange).toHaveBeenCalledWith(["ci"])
    expect(screen.getByRole("button", { name: "CI" })).toHaveAttribute("aria-pressed", "true")
  })
})
