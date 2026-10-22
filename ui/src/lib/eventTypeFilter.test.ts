import { describe, it, expect } from "vitest"
import { EVENT_CATEGORIES, categoriesFor, eventTypesFor } from "./eventTypeFilter"

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

describe("the Task activity category", () => {
  it("lives under Tasks and sends the server's exact category value", () => {
    // The server selects every task_*/subtask_* event for exactly "task" —
    // not a prefix, and not the individual types.
    expect(EVENT_CATEGORIES.task).toEqual([{ key: "task", label: "Task activity", types: ["task"] }])
  })

  it("draws no bar while it is the only category, as with Slack", () => {
    // Under the Tasks source every event already is task activity, so a
    // one-button bar would change nothing.
    expect(categoriesFor(["task"])).toEqual([])
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
