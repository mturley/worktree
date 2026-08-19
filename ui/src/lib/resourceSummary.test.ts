import { describe, it, expect } from "vitest"
import { resourceSummary } from "./resourceSummary"

describe("resourceSummary", () => {
  it("summarizes focus by type in canonical order (pr, jira) with related rollup", () => {
    expect(resourceSummary({ pr: 2, jira: 3 }, 2)).toBe("2 PRs, 3 Jira issues · 2 related resources")
  })

  it("orders known types before unknown types, and sorts unknown types alphabetically", () => {
    expect(resourceSummary({ zeta: 1, jira: 1, pr: 1 }, 0)).toBe("1 PR, 1 Jira issue, 1 zeta")
  })

  it("uses singular labels for a count of exactly 1", () => {
    expect(resourceSummary({ pr: 1 }, 0)).toBe("1 PR")
    expect(resourceSummary({ jira: 1 }, 1)).toBe("1 Jira issue · 1 related resource")
  })

  it("omits types with a zero count", () => {
    expect(resourceSummary({ pr: 0, jira: 2 }, 0)).toBe("2 Jira issues")
  })

  it("shows only the related rollup when there is no focus breakdown", () => {
    expect(resourceSummary({}, 3)).toBe("3 related resources")
  })

  it("returns an empty string when there is nothing to summarize", () => {
    expect(resourceSummary({}, 0)).toBe("")
  })
})
