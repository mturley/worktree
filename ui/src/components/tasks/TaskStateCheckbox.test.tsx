import { describe, expect, it } from "vitest"
import { taskStateLabel } from "./TaskStateCheckbox"

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
