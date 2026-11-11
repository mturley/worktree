import { describe, it, expect } from "vitest"
import eventMetaSource from "./eventMeta.tsx?raw"
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

describe("the Tasks subfilters", () => {
  it("offers Progress, Blockers and Created / deleted under Tasks", () => {
    expect(categoriesFor(["task"])).toEqual([
      { key: "progress", label: "Progress", types: ["task_work_logged", "task_state_changed", "subtask_checked", "subtask_unchecked"] },
      { key: "blockers", label: "Blockers", types: ["task_blocker_resolved", "task_blocker_unresolved"] },
      { key: "lifecycle", label: "Created / deleted", types: ["task_created", "task_deleted"] },
    ])
  })

  it("expands a selected task category to its exact types", () => {
    expect(eventTypesFor(["task"], ["blockers"])).toEqual(["task_blocker_resolved", "task_blocker_unresolved"])
  })

  it("puts every task event type in exactly one category", () => {
    const types = [...eventMetaSource.matchAll(/^\s+((?:task|subtask)_[a-z_]+): task\(/gm)].map((m) => m[1])
    expect(types.length).toBeGreaterThan(0)
    const all = EVENT_CATEGORIES.task.flatMap((c) => c.types)
    for (const t of types) expect(all.filter((x) => x === t), t).toHaveLength(1)
    for (const t of all) expect(types, t).toContain(t)
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

describe("the PR Commits category", () => {
  it("includes needs-rebase events", () => {
    expect(EVENT_CATEGORIES.pr.find((c) => c.key === "commits")?.types).toContain("pr_needs_rebase")
  })
})

describe("Edits category", () => {
  it("includes PR description changes", () => {
    expect(EVENT_CATEGORIES.pr.find((c) => c.key === "edits")?.types).toContain("pr_description_changed")
    expect(eventTypesFor(["pr"], ["edits"])).toContain("pr_description_changed")
  })
})
