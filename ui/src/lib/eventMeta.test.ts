import { describe, it, expect } from "vitest"
import { eventMeta } from "./eventMeta"

describe("eventMeta", () => {
  it("gives one hue per source", () => {
    expect(eventMeta("pr_comment").hue).toBe("indigo")
    expect(eventMeta("ci_failed").hue).toBe("indigo") // CI is GitHub too
    expect(eventMeta("jira_comment").hue).toBe("blue")
    expect(eventMeta("slack_reply").hue).toBe("grape")
    expect(eventMeta("watcher_error").hue).toBe("gray")
  })

  it("gives one shade per kind, across sources", () => {
    // Same kind from different sources shares a shade; only the hue differs.
    expect(eventMeta("pr_comment").kind).toBe("comment")
    expect(eventMeta("jira_comment").kind).toBe("comment")
    expect(eventMeta("slack_reply").kind).toBe("comment")

    expect(eventMeta("pr_merged").kind).toBe("status")
    expect(eventMeta("jira_status_change").kind).toBe("status")

    expect(eventMeta("pr_new_commits").kind).toBe("activity")
    expect(eventMeta("jira_assigned").kind).toBe("activity")
  })

  it("renders status brighter than chatter, since the UI is dark-only", () => {
    // Mantine palettes run light->dark, so brighter means a LOWER index.
    const shade = (t: string) => Number(eventMeta(t).color.match(/-(\d)\)$/)![1])
    expect(shade("pr_merged")).toBeLessThan(shade("pr_new_commits"))
    expect(shade("pr_new_commits")).toBeLessThan(shade("pr_comment"))
  })

  it("classifies CI variants by substring, so new library types still land right", () => {
    // The library has ci_passed, ci_workflows_partial_failure, ci_check_failed…
    // and may add more without a release here.
    expect(eventMeta("ci_workflows_partial_failure").label).toBe("CI failed")
    expect(eventMeta("ci_check_passed").label).toBe("CI passed")
    expect(eventMeta("ci_some_future_variant").hue).toBe("indigo")
  })

  it("falls back rather than throwing on an unknown type", () => {
    const m = eventMeta("totally_made_up")
    expect(m.color).toContain("var(--mantine-color-")
    expect(m.Icon).toBeTruthy()
  })
})
