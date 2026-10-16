import { describe, expect, it, vi } from "vitest"
import type { ResourceDTO, TimelineEvent, WorktreeSummary } from "../../api/types"
import { buildSuggestions, SUGGESTION_LIMITS } from "./suggestions"

const wt = (branch: string): WorktreeSummary => ({
  path: `/wt/${branch}`, repo: "odh", branch, on_disk: true, resource_count: 0, primary_count: 0,
  latest_event_ts: "", primary_by_type: {}, related_count: 0, focus_resources: [],
})
const res = (id: string, title: string): ResourceDTO => ({ type: "jira", id, url: "u", primary: true, title })
const ev = (id: string): TimelineEvent => ({
  id, ts: "", external_ts: "", source: "github", type: "pr_comment", type_label: "Comment", title: `oauth ${id}`,
  body: "", author: "a", resource_type: "pr", resource_id: "o/r#1", resource_url: "", resource_title: "", worktrees: [],
})
const go = { worktree: vi.fn(), resource: vi.fn(), event: vi.fn() }

describe("buildSuggestions", () => {
  it("groups, ranks and caps", () => {
    const out = buildSuggestions({
      terms: ["oauth"],
      worktrees: ["x-oauth", "oauth-fix", "a-oauth", "b-oauth", "unrelated"].map((b) => ({ w: wt(b), workspaceTitles: [], resources: [] })),
      resources: [res("J-1", "about oauth"), res("J-2", "OAuth first"), res("J-3", "nothing")].map((r) => ({ r, worktreePath: "/wt/a" })),
      events: ["e1", "e2", "e3", "e4"].map(ev),
      go,
    })
    const groups = out.map((s) => s.group)
    expect(groups.filter((g) => g === "Worktrees")).toHaveLength(SUGGESTION_LIMITS.worktrees)
    expect(out.find((s) => s.group === "Worktrees")?.label).toBe("oauth-fix") // prefix ranks first
    expect(out.filter((s) => s.group === "Resources").map((s) => s.label)).toEqual(["OAuth first", "about oauth"])
    expect(groups.filter((g) => g === "Activity")).toHaveLength(SUGGESTION_LIMITS.events)
    expect(groups).toEqual([...groups].sort((a, b) => ["Worktrees", "Resources", "Activity"].indexOf(a) - ["Worktrees", "Resources", "Activity"].indexOf(b)))
  })
  it("picks route through go", () => {
    const r = res("J-2", "OAuth first")
    const out = buildSuggestions({ terms: ["oauth"], resources: [{ r, worktreePath: "/wt/a" }], events: [ev("e1")], go })
    out.find((s) => s.group === "Resources")!.onPick()
    expect(go.resource).toHaveBeenCalledWith(r, "/wt/a")
    out.find((s) => s.group === "Activity")!.onPick()
    expect(go.event).toHaveBeenCalled()
    expect(out.some((s) => s.group === "Worktrees")).toBe(false)
  })
  it("is empty without terms", () => {
    expect(buildSuggestions({ terms: [], resources: [], events: [ev("e1")], go })).toEqual([])
  })
})
