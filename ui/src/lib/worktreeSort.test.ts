import { describe, expect, it } from "vitest"
import type { WorktreeSummary } from "../api/types"
import { cmuxPositions, isSortMode, resolveSortMode, sortWorktrees, type SortOptions } from "./worktreeSort"

function wt(branch: string, over: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    path: `/wt/${branch}`, repo: "odh", branch,
    on_disk: true, resource_count: 0, primary_count: 0, latest_event_ts: "",
    primary_by_type: {}, related_count: 0, focus_resources: [],
    ...over,
  }
}

const opts = (over: Partial<SortOptions> = {}): SortOptions => ({
  mode: "name", createdDir: "asc", cmuxPositions: {}, ...over,
})

const branches = (items: WorktreeSummary[]) => items.map((w) => w.branch)

describe("sortWorktrees", () => {
  it("does not mutate its input", () => {
    const items = [wt("b"), wt("a")]
    sortWorktrees(items, opts())
    expect(branches(items)).toEqual(["b", "a"])
  })

  it("name: repo, then branch, then path", () => {
    const items = [
      wt("b", { repo: "zeta" }),
      wt("b", { repo: "alpha", path: "/wt/2" }),
      wt("a", { repo: "alpha" }),
      wt("b", { repo: "alpha", path: "/wt/1" }),
    ]
    expect(sortWorktrees(items, opts()).map((w) => `${w.repo}/${w.branch}${w.path}`)).toEqual([
      "alpha/a/wt/a", "alpha/b/wt/1", "alpha/b/wt/2", "zeta/b/wt/b",
    ])
  })

  it("activity: newest first, no events last, ties by name", () => {
    const items = [
      wt("none"),
      wt("old", { latest_event_ts: "2026-09-01T00:00:00Z" }),
      wt("new-b", { latest_event_ts: "2026-09-20T00:00:00Z" }),
      wt("new-a", { latest_event_ts: "2026-09-20T00:00:00Z" }),
    ]
    expect(branches(sortWorktrees(items, opts({ mode: "activity" })))).toEqual(["new-a", "new-b", "old", "none"])
  })

  it("created: ascending by default, descending on request, unparseable last both ways", () => {
    const items = [
      wt("legacy", { created_at: "now" }),
      wt("mid", { created_at: "2026-08-15T00:00:00Z" }),
      wt("missing"),
      wt("first", { created_at: "2026-08-01T00:00:00Z" }),
      wt("last", { created_at: "2026-09-01T00:00:00Z" }),
    ]
    expect(branches(sortWorktrees(items, opts({ mode: "created" })))).toEqual(["first", "mid", "last", "legacy", "missing"])
    expect(branches(sortWorktrees(items, opts({ mode: "created", createdDir: "desc" })))).toEqual(["last", "mid", "first", "legacy", "missing"])
  })

  it("cmux: by position, no workspace last, ties by name", () => {
    const items = [wt("none-b"), wt("second"), wt("none-a"), wt("first")]
    const pos = { "/wt/first": 0, "/wt/second": 4 }
    expect(branches(sortWorktrees(items, opts({ mode: "cmux", cmuxPositions: pos })))).toEqual(["first", "second", "none-a", "none-b"])
  })

  it("unread: unread first, more unread first, then latest activity, then name", () => {
    const items = [
      wt("read-new", { latest_event_ts: "2026-09-29T00:00:00Z" }),
      wt("slack-only", { has_unread: true, unread_count: 0, latest_event_ts: "2026-09-02T00:00:00Z" }),
      wt("three", { has_unread: true, unread_count: 3 }),
      wt("one-old", { has_unread: true, unread_count: 1, latest_event_ts: "2026-09-01T00:00:00Z" }),
      wt("one-new", { has_unread: true, unread_count: 1, latest_event_ts: "2026-09-10T00:00:00Z" }),
      wt("read-none"),
    ]
    expect(branches(sortWorktrees(items, opts({ mode: "unread" })))).toEqual([
      "three", "one-new", "one-old", "slack-only", "read-new", "read-none",
    ])
  })
})

describe("cmuxPositions", () => {
  it("takes each path's EARLIEST workspace, not the first in its array", () => {
    expect(cmuxPositions({
      "/wt/a": [
        { ref: "workspace:9", title: "late", selected: false, index: 7 },
        { ref: "workspace:3", title: "early", selected: false, index: 2 },
      ],
      "/wt/b": [{ ref: "workspace:1", title: "b", selected: false, index: 0 }],
    })).toEqual({ "/wt/a": 2, "/wt/b": 0 })
  })

  it("skips workspaces without an index and tolerates missing matches", () => {
    expect(cmuxPositions({ "/wt/a": [{ ref: "w", title: "t", selected: false }] })).toEqual({})
    expect(cmuxPositions(undefined)).toEqual({})
  })
})

describe("resolveSortMode", () => {
  it("honours any saved non-cmux mode immediately, even while cmux is pending", () => {
    expect(resolveSortMode("name", true, false)).toBe("name")
    expect(resolveSortMode("created", false, true)).toBe("created")
  })

  it("is undecided while cmux is pending and the answer matters", () => {
    expect(resolveSortMode(null, true, false)).toBeNull()
    expect(resolveSortMode("cmux", true, false)).toBeNull()
  })

  it("defaults to cmux when available, activity otherwise", () => {
    expect(resolveSortMode(null, false, true)).toBe("cmux")
    expect(resolveSortMode(null, false, false)).toBe("activity")
  })

  it("falls back to activity for a saved cmux mode when cmux is gone", () => {
    expect(resolveSortMode("cmux", false, false)).toBe("activity")
    expect(resolveSortMode("cmux", false, true)).toBe("cmux")
  })
})

describe("isSortMode", () => {
  it("accepts only known modes", () => {
    expect(isSortMode("unread")).toBe(true)
    expect(isSortMode("bogus")).toBe(false)
    expect(isSortMode(null)).toBe(false)
  })
})
