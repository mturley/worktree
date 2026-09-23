import { describe, it, expect } from "vitest"
import type { WorktreeSummary } from "../api/types"
import { unreadBadge, badgeTitle } from "./unreadBadge"

function wt(over: Partial<WorktreeSummary>): WorktreeSummary {
  return {
    path: "/w/a", repo: "r", branch: "b", on_disk: true,
    resource_count: 0, primary_count: 0, latest_event_ts: "",
    primary_by_type: {}, related_count: 0, focus_resources: [],
    ...over,
  }
}

describe("unreadBadge", () => {
  it("is not unread with no worktrees", () => {
    expect(unreadBadge([])).toEqual({ unread: false, count: 0 })
    expect(unreadBadge(undefined)).toEqual({ unread: false, count: 0 })
  })

  it("survives a non-array response, which is what a null list arrives as", () => {
    expect(unreadBadge(null as unknown as WorktreeSummary[])).toEqual({ unread: false, count: 0 })
    expect(unreadBadge({} as unknown as WorktreeSummary[])).toEqual({ unread: false, count: 0 })
  })

  it("is unread when any worktree is, and sums the counts", () => {
    const list = [
      wt({ path: "/w/a", has_unread: true, unread_count: 2 }),
      wt({ path: "/w/b", has_unread: false, unread_count: 0 }),
      wt({ path: "/w/c", has_unread: true, unread_count: 3 }),
    ]
    expect(unreadBadge(list)).toEqual({ unread: true, count: 5 })
  })

  it("stays unread with a zero count, which is how a Slack thread arrives", () => {
    expect(unreadBadge([wt({ has_unread: true })])).toEqual({ unread: true, count: 0 })
  })

  it("ignores counts on worktrees an older response left without has_unread", () => {
    expect(unreadBadge([wt({ unread_count: 4 })])).toEqual({ unread: false, count: 0 })
  })
})

describe("badgeTitle", () => {
  it("is the bare title when nothing is unread", () => {
    expect(badgeTitle({ unread: false, count: 0 })).toBe("worktree")
  })

  it("prefixes the count when there is one", () => {
    expect(badgeTitle({ unread: true, count: 3 })).toBe("(3) worktree")
  })

  it("falls back to a dot when unread without a countable tally", () => {
    expect(badgeTitle({ unread: true, count: 0 })).toBe("• worktree")
  })
})
