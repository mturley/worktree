import { describe, expect, it } from "vitest"
import { jiraStatusColor, prStateColor } from "./statusColors"

describe("prStateColor", () => {
  it("colours each PR state, case-insensitively", () => {
    expect(prStateColor("OPEN")).toBe("green")
    expect(prStateColor("merged")).toBe("violet")
    expect(prStateColor("CLOSED")).toBe("red")
  })

  it("is gray for a draft or an unknown state", () => {
    expect(prStateColor("OPEN", true)).toBe("gray")
    expect(prStateColor(undefined)).toBe("gray")
    expect(prStateColor("weird")).toBe("gray")
  })
})

describe("jiraStatusColor", () => {
  it.each([
    ["New", "gray"], ["Backlog", "gray"], ["To Do", "gray"], ["Refinement", "gray"],
    ["In Progress", "blue"],
    ["Review", "violet"], ["Code Review", "violet"],
    ["Testing", "teal"], ["QA", "teal"],
    ["Blocked", "orange"],
    ["Resolved", "green"], ["Closed", "green"], ["Done", "green"],
  ])("%s is %s", (status, color) => {
    expect(jiraStatusColor(status)).toBe(color)
  })

  it("is gray without a status", () => {
    expect(jiraStatusColor(undefined)).toBe("gray")
    expect(jiraStatusColor("")).toBe("gray")
  })
})
