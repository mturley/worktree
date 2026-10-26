import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { TaskStateCheckbox, taskStateLabel } from "./TaskStateCheckbox"

afterEach(cleanup)

describe("taskStateLabel", () => {
  it("names every task state", () => {
    expect(taskStateLabel("not_started")).toBe("Not started")
    expect(taskStateLabel("in_progress")).toBe("In progress")
    expect(taskStateLabel("done")).toBe("Done")
  })

  it("returns anything else unchanged, inherited property names included", () => {
    expect(taskStateLabel("deleted")).toBe("deleted")
    expect(taskStateLabel("toString")).toBe("toString")
    expect(taskStateLabel("constructor")).toBe("constructor")
  })
})

describe("TaskStateCheckbox menu", () => {
  it("draws each option's checkbox", async () => {
    render(<MantineProvider><TaskStateCheckbox state="not_started" title="t" onPick={() => {}} /></MantineProvider>)
    await userEvent.click(screen.getByRole("button", { name: "State of “t”: Not started" }))
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.querySelector("[data-state-box]")?.getAttribute("data-state"))).toEqual([
      "not_started", "in_progress", "done",
    ])
  })
})
