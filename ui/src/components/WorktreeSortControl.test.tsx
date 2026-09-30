import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { WorktreeSortControl, type WorktreeSortControlProps } from "./WorktreeSortControl"

function renderControl(over: Partial<WorktreeSortControlProps> = {}) {
  const props: WorktreeSortControlProps = {
    mode: "activity", createdDir: "asc", cmuxAvailable: true,
    onModeChange: vi.fn(), onCreatedDirChange: vi.fn(), ...over,
  }
  render(<MantineProvider><WorktreeSortControl {...props} /></MantineProvider>)
  return props
}

const optionLabels = () => screen.getAllByRole("option").map((o) => o.textContent)

afterEach(cleanup)

describe("WorktreeSortControl", () => {
  it("lists every mode, cmux first, when cmux is available", () => {
    renderControl()
    expect(optionLabels()).toEqual(["cmux order", "Latest activity", "Created", "Name", "Unread first"])
  })

  it("omits cmux order when cmux is unavailable", () => {
    renderControl({ cmuxAvailable: false })
    expect(optionLabels()).toEqual(["Latest activity", "Created", "Name", "Unread first"])
  })

  it("reports a chosen mode", async () => {
    const props = renderControl()
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sort worktrees" }), "Unread first")
    expect(props.onModeChange).toHaveBeenCalledWith("unread")
  })

  it("renders nothing while the mode is undecided", () => {
    renderControl({ mode: null })
    expect(screen.queryByRole("combobox", { name: "Sort worktrees" })).not.toBeInTheDocument()
  })

  it("shows the direction toggle only in created mode", () => {
    renderControl({ mode: "activity" })
    expect(screen.queryByRole("button", { name: "Toggle sort direction" })).not.toBeInTheDocument()
    cleanup()
    renderControl({ mode: "created" })
    expect(screen.getByRole("button", { name: "Toggle sort direction" })).toBeInTheDocument()
  })

  it("flips the direction", async () => {
    const props = renderControl({ mode: "created", createdDir: "asc" })
    await userEvent.click(screen.getByRole("button", { name: "Toggle sort direction" }))
    expect(props.onCreatedDirChange).toHaveBeenCalledWith("desc")
  })
})
