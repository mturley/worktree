import { describe, it, expect } from "vitest"
import { eventMeta } from "./eventMeta"

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
