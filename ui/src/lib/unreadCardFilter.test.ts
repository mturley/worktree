import { describe, expect, it } from "vitest"
import type { ResourceDTO, WorktreeSummary } from "../api/types"
import { filterWorktreeByUnread } from "./unreadCardFilter"

const res = (type: string, id: string, over: Partial<ResourceDTO> = {}) =>
  ({ type, id, url: "", primary: true, ...over }) as ResourceDTO

const wt = (over: Partial<WorktreeSummary> = {}): WorktreeSummary => ({
  path: "/w", repo: "r", branch: "b", on_disk: true, resource_count: 0, primary_count: 0,
  latest_event_ts: "", primary_by_type: {}, related_count: 0, focus_resources: [],
  ...over,
})

describe("filterWorktreeByUnread", () => {
  it("keeps only the focus resources with unreads", () => {
    const w = wt({
      focus_resources: [res("pr", "1", { unread_count: 2 }), res("jira", "J-1"), res("slack", "t", { has_unread: true })],
    })
    expect(filterWorktreeByUnread(w, undefined).focus_resources.map((r) => r.id)).toEqual(["1", "t"])
  })

  it("lists related resources with unreads after the focus ones, and drops the related line", () => {
    const w = wt({ focus_resources: [res("pr", "1", { unread_count: 1 })], related_by_type: { slack: 2, jira: 1 } })
    const followed = [
      res("pr", "1", { unread_count: 1 }),
      res("slack", "s1", { primary: false, has_unread: true }),
      res("slack", "s2", { primary: false }),
      res("jira", "J-2", { primary: false, unread_count: 3 }),
    ]
    const out = filterWorktreeByUnread(w, followed)
    expect(out.focus_resources.map((r) => r.id)).toEqual(["1", "s1", "J-2"])
    expect(out.related_by_type).toEqual({})
  })

  it("does not repeat a focus resource that the followed list also holds", () => {
    const w = wt({ focus_resources: [res("pr", "1")] })
    const out = filterWorktreeByUnread(w, [res("pr", "1", { unread_count: 1 })])
    expect(out.focus_resources).toEqual([])
  })
})
