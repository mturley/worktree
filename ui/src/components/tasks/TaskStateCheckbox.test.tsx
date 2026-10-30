import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { StateBox, TaskStateCheckbox, taskStateLabel } from "./TaskStateCheckbox"

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
    render(<MantineProvider><TaskStateCheckbox state="not_started" priority="none" title="t" onPick={() => {}} /></MantineProvider>)
    await userEvent.click(screen.getByRole("button", { name: "State of “t”: Not started" }))
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.querySelector("[data-state-box]")?.getAttribute("data-state"))).toEqual([
      "not_started", "in_progress", "done",
    ])
  })
})

describe("StateBox colour", () => {
  it("takes its task's priority colour, the text colour with none, and lime without a priority", () => {
    const { container } = render(
      <MantineProvider>
        <StateBox state="done" size={16} priority="high" />
        <StateBox state="done" size={16} priority="low" />
        <StateBox state="done" size={16} priority="none" />
        <StateBox state="done" size={16} />
      </MantineProvider>,
    )
    const boxes = Array.from(container.querySelectorAll<HTMLElement>("[data-state-box]"))
    expect(boxes.map((b) => b.getAttribute("style")?.match(/border: 2px solid ([^;]+)/)?.[1])).toEqual([
      "var(--mantine-color-red-4)", "var(--mantine-color-blue-8)", "var(--mantine-color-text)", "var(--task-accent)",
    ])
    // A white check on low's dark blue, dark elsewhere.
    expect(boxes[1].style.color).toBe("var(--mantine-color-white)")
    expect(boxes[0].style.color).toBe("var(--mantine-color-dark-9)")
  })
})
