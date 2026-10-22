import { describe, it, expect } from "vitest"
import { eventLabel, eventMeta } from "./eventMeta"

describe("task events", () => {
  const TASK_TYPES = [
    "task_created", "task_edited", "task_state_changed", "task_deleted", "task_linked",
    "task_unlinked", "task_focus_changed", "subtask_added", "subtask_edited", "subtask_checked",
    "subtask_unchecked", "subtask_removed", "task_event_linked", "task_event_unlinked",
  ]

  it("paints every task event type in the task accent, not a Mantine palette colour", () => {
    for (const t of TASK_TYPES) expect(eventMeta(t).cssColor, t).toBe("var(--task-accent)")
  })

  it("gives every task event type its own readable label, never the raw type", () => {
    for (const t of TASK_TYPES) {
      expect(eventMeta(t).label, t).not.toBe(t)
      expect(eventMeta(t).label, t).not.toContain("_")
    }
    expect(eventLabel("subtask_checked")).toBe("Subtask checked")
    expect(eventLabel("task_state_changed")).toBe("State changed")
  })

  it("keeps a Mantine colour NAME for surfaces that take one", () => {
    // `color` is documented as a palette name usable as a Badge colour; the
    // accent is a CSS variable, so it can only live in cssColor.
    expect(eventMeta("task_created").color).toBe("lime")
  })

  it("gives a task event type the server adds later the accent too", () => {
    expect(eventMeta("task_blocker_added").cssColor).toBe("var(--task-accent)")
    expect(eventMeta("subtask_reordered").cssColor).toBe("var(--task-accent)")
  })
})

describe("eventMeta", () => {
  it("gives distinct colours to distinct events, including within one source", () => {
    // The point of per-type colours: two GitHub events that mean different
    // things should not look alike.
    expect(eventMeta("pr_merged").color).not.toBe(eventMeta("pr_closed").color)
    expect(eventMeta("pr_approved").color).not.toBe(eventMeta("pr_comment").color)
    expect(eventMeta("jira_assigned").color).not.toBe(eventMeta("jira_comment").color)
  })

  it("shares a colour where the outcome is genuinely the same", () => {
    expect(eventMeta("ci_check_failed").color).toBe(eventMeta("ci_workflows_failed").color)
    expect(eventMeta("ci_passed").color).toBe("green")
    expect(eventMeta("ci_check_failed").color).toBe("red")
  })

  it("exposes both a Mantine colour name and a resolved CSS value", () => {
    const m = eventMeta("pr_merged")
    // The badge takes the name; the dot needs a raw value.
    expect(m.color).toBe("violet")
    expect(m.cssColor).toBe(`var(--mantine-color-violet-${m.shade})`)
  })

  it("classifies CI variants by substring, so new library types still land right", () => {
    expect(eventMeta("ci_workflows_partial_failure").label).toBe("CI failed")
    expect(eventMeta("ci_check_passed").label).toBe("CI passed")
    expect(eventMeta("ci_some_future_variant").color).toBe("gray")
  })

  it("falls back rather than throwing on an unknown type", () => {
    const m = eventMeta("totally_made_up")
    expect(m.cssColor).toContain("var(--mantine-color-")
    expect(m.Icon).toBeTruthy()
  })
})
