import { describe, expect, it } from "vitest"
import type { AllResourceDTO } from "../api/types"
import { EMPTY_FILTER, distinctValues, matchesFilter, sortResources, statusRank, timestampMs } from "./resourceListFilter"

const wt = [{ path: "/wt/a", repo: "r", branch: "a" }]
const res = (over: Partial<AllResourceDTO>): AllResourceDTO =>
  ({ type: "pr", id: "x", url: "u", primary: false, worktrees: wt, ...over })

const openPR = res({ id: "o/r#1", state: "OPEN", ci_status: "failure", mine: true, updated_at: "2026-01-03T00:00:00Z", created_at: "2025-12-01T00:00:00Z" })
const mergedPR = res({ id: "o/r#2", state: "MERGED", review_decision: "APPROVED", updated_at: "2026-01-01T00:00:00Z", created_at: "2025-12-05T00:00:00Z" })
const issue = res({ type: "jira", id: "J-1", status: "In Progress", mine: true, updated_at: "2026-01-02T00:00:00Z", unread_count: 2 })
const blocked = res({ type: "jira", id: "J-2", status: "Blocked" })
const thread = res({ type: "slack", id: "C1:1.0", channel_name: "eng", updated_ts: "1767400000.0001", has_unread: true })

describe("matchesFilter", () => {
  it("passes everything with no filter", () => {
    for (const r of [openPR, mergedPR, issue, thread]) expect(matchesFilter(r, EMPTY_FILTER, false)).toBe(true)
  })

  it("keeps only unread resources when unread-only is on", () => {
    expect([openPR, issue, thread].filter((r) => matchesFilter(r, EMPTY_FILTER, true))).toEqual([issue, thread])
  })

  it("narrows to a type", () => {
    const f = { ...EMPTY_FILTER, type: "jira" }
    expect([openPR, issue, thread].filter((r) => matchesFilter(r, f, false))).toEqual([issue])
  })

  it("ORs values within a PR group and ANDs across groups", () => {
    const states = { ...EMPTY_FILTER, type: "pr", prStates: ["OPEN", "MERGED"] }
    expect([openPR, mergedPR].filter((r) => matchesFilter(r, states, false))).toEqual([openPR, mergedPR])
    const openFailing = { ...states, prStates: ["MERGED"], prConditions: ["ci_failure"] }
    expect([openPR, mergedPR].filter((r) => matchesFilter(r, openFailing, false))).toEqual([])
    const approvedOrFailing = { ...EMPTY_FILTER, type: "pr", prConditions: ["ci_failure", "approved"] }
    expect([openPR, mergedPR].filter((r) => matchesFilter(r, approvedOrFailing, false))).toEqual([openPR, mergedPR])
  })

  it("filters to my PRs and my issues", () => {
    expect([openPR, mergedPR].filter((r) => matchesFilter(r, { ...EMPTY_FILTER, type: "pr", mine: true }, false))).toEqual([openPR])
    expect([issue, blocked].filter((r) => matchesFilter(r, { ...EMPTY_FILTER, type: "jira", mine: true }, false))).toEqual([issue])
  })

  it("filters Jira by status and Slack by channel", () => {
    expect([issue, blocked].filter((r) => matchesFilter(r, { ...EMPTY_FILTER, type: "jira", jiraStatuses: ["Blocked"] }, false))).toEqual([blocked])
    expect(matchesFilter(thread, { ...EMPTY_FILTER, type: "slack", slackChannels: ["random"] }, false)).toBe(false)
  })
})

describe("sortResources", () => {
  const all = [mergedPR, blocked, openPR, issue, thread]
  const ids = (rs: AllResourceDTO[]) => rs.map((r) => r.id)

  it("sorts by last updated, Slack threads by their ts, and undated last either way", () => {
    expect(ids(sortResources(all, "updated", "desc"))).toEqual(["C1:1.0", "o/r#1", "J-1", "o/r#2", "J-2"])
    expect(ids(sortResources(all, "updated", "asc"))).toEqual(["o/r#2", "J-1", "o/r#1", "C1:1.0", "J-2"])
  })

  it("sorts by created", () => {
    expect(ids(sortResources([openPR, mergedPR], "created", "desc"))).toEqual(["o/r#2", "o/r#1"])
  })

  it("sorts by status: blocked, in progress and open first, merged after", () => {
    expect(ids(sortResources(all, "status", "asc")).slice(0, 4)).toEqual(["J-2", "o/r#1", "J-1", "o/r#2"])
    expect(statusRank(thread)).toBeGreaterThan(statusRank(mergedPR))
  })

  it("puts unread first", () => {
    expect(ids(sortResources(all, "unread", "asc")).slice(0, 2)).toEqual(["C1:1.0", "J-1"])
  })
})

describe("helpers", () => {
  it("parses RFC3339 and Slack timestamps", () => {
    expect(timestampMs("1700000000.5")).toBe(1700000000500)
    expect(timestampMs("2026-01-01T00:00:00Z")).toBe(Date.UTC(2026, 0, 1))
    expect(timestampMs("garbage")).toBeNull()
    expect(timestampMs(undefined)).toBeNull()
  })

  it("lists the distinct values of one type", () => {
    expect(distinctValues([issue, blocked, issue, openPR], "jira", (r) => r.status)).toEqual(["Blocked", "In Progress"])
  })
})
