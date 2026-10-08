import { describe, expect, it } from "vitest"
import type { ResourceDTO, WorktreeSummary } from "../api/types"
import { filterWorktreeBySources, matchesSources } from "./sourceFilter"

const res = (type: string, id: string) => ({ type, id, primary: true }) as ResourceDTO

const wt = (over: Partial<WorktreeSummary> = {}): WorktreeSummary => ({
  path: "/w", repo: "r", branch: "b", on_disk: true, resource_count: 0, primary_count: 0,
  latest_event_ts: "", primary_by_type: {}, related_count: 0, focus_resources: [],
  ...over,
})

describe("matchesSources", () => {
  it("treats an empty selection as every source", () => {
    expect(matchesSources("jira", [])).toBe(true)
  })
  it("matches only the selected sources", () => {
    expect(matchesSources("jira", ["jira"])).toBe(true)
    expect(matchesSources("pr", ["jira"])).toBe(false)
  })
})

describe("filterWorktreeBySources", () => {
  it("returns the worktree untouched with no selection", () => {
    const w = wt({ focus_resources: [res("pr", "1")] })
    expect(filterWorktreeBySources(w, [])).toBe(w)
  })

  it("keeps only focus resources and related counts of the selected type", () => {
    const w = wt({
      focus_resources: [res("pr", "1"), res("jira", "J-1")],
      related_by_type: { slack: 2, jira: 1 },
    })
    const out = filterWorktreeBySources(w, ["jira"])
    expect(out?.focus_resources.map((r) => r.id)).toEqual(["J-1"])
    expect(out?.related_by_type).toEqual({ jira: 1 })
  })

  it("keeps a worktree whose only match is a related resource", () => {
    const w = wt({ focus_resources: [res("pr", "1")], related_by_type: { slack: 1 } })
    const out = filterWorktreeBySources(w, ["slack"])
    expect(out?.focus_resources).toEqual([])
    expect(out?.related_by_type).toEqual({ slack: 1 })
  })

  it("drops a worktree with nothing of the selected type", () => {
    const w = wt({ focus_resources: [res("pr", "1")], related_by_type: { jira: 0 } })
    expect(filterWorktreeBySources(w, ["jira"])).toBeNull()
  })

  it("tolerates a missing related_by_type", () => {
    expect(filterWorktreeBySources(wt({ focus_resources: [res("pr", "1")] }), ["pr"])).not.toBeNull()
    expect(filterWorktreeBySources(wt(), ["pr"])).toBeNull()
  })
})
