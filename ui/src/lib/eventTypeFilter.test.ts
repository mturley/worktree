import { describe, it, expect } from "vitest"
import { categoriesFor, eventTypesFor } from "./eventTypeFilter"

describe("categoriesFor", () => {
  it("offers categories only under exactly one source", () => {
    expect(categoriesFor([])).toEqual([])
    expect(categoriesFor(["pr", "jira"])).toEqual([])
    expect(categoriesFor(["pr"]).map((c) => c.label)).toContain("Comments")
  })

  it("offers nothing for a source with a single kind of event", () => {
    expect(categoriesFor(["slack"])).toEqual([])
  })
})

describe("eventTypesFor", () => {
  it("expands the selected categories to their event types", () => {
    expect(eventTypesFor(["pr"], ["comments", "ci"])).toEqual(["pr_comment", "pr_review_comment", "ci_*"])
  })

  it("is empty when nothing is selected", () => {
    expect(eventTypesFor(["pr"], [])).toEqual([])
  })

  it("drops keys that belong to no category of the current source", () => {
    // "ci" is a GitHub category; under Jira it must not narrow to nothing.
    expect(eventTypesFor(["jira"], ["ci"])).toEqual([])
  })
})
