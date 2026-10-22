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
  it("carries each row's thing, for rendering it as the rest of the UI does", () => {
    const r = res("J-2", "OAuth first")
    const w = wt("oauth-fix")
    const out = buildSuggestions({
      terms: ["oauth"], worktrees: [{ w, workspaceTitles: [], resources: [] }],
      resources: [{ r, worktreePath: "/wt/a" }], events: [ev("e1")], go,
    })
    expect(out.map((s) => s.item?.kind)).toEqual(["worktree", "resource", "event"])
    expect(out[0].item).toEqual({ kind: "worktree", w })
    expect(out[1].item).toEqual({ kind: "resource", r })
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
  it("opens the task for a task event's row, as the feeds' rows do", () => {
    const task = vi.fn()
    const event = vi.fn()
    const te: TimelineEvent = { ...ev("task:7"), source: "tasks", type: "task_edited", resource_type: "task", resource_id: "42", resource_title: "oauth task" }
    const out = buildSuggestions({ terms: ["oauth"], resources: [], events: [te, ev("e1")], go: { ...go, event, task } })
    out[0].onPick()
    expect(task).toHaveBeenCalledWith(42)
    expect(event).not.toHaveBeenCalled()
    // A watcher event still routes through go.event.
    out[1].onPick()
    expect(event).toHaveBeenCalledTimes(1)
    expect(task).toHaveBeenCalledTimes(1)
    // Matched on the task's title: the row names the task, not its id.
    const viaTask = buildSuggestions({
      terms: ["oauth"], resources: [], events: [{ ...te, match: { field: "resource", snippet: "oauth task" } }], go,
    })
    expect(viaTask[0].detail).toBe("oauth task")
  })
  it("describes an Activity row by the field that matched", () => {
    const detailOf = (e: TimelineEvent) =>
      buildSuggestions({ terms: ["x"], resources: [], events: [e], go }).find((s) => s.group === "Activity")?.detail
    expect(detailOf({ ...ev("e1"), match: { field: "body", snippet: "…a snippet…" } })).toBe("…a snippet…")
    expect(detailOf({ ...ev("e1"), match: { field: "title", snippet: "oauth e1" } })).toBe("a")
    expect(detailOf(ev("e1"))).toBe("a")
    const viaResource = { ...ev("e1"), match: { field: "resource", snippet: "o/r#1" } }
    expect(detailOf(viaResource)).toBe("#1")
    expect(detailOf({ ...viaResource, resource: res("J-1", "Tracked title") })).toBe("Tracked title")
    expect(detailOf({ ...viaResource, resource: { ...res("J-1", "Tracked title"), custom_name: "My name" } })).toBe("My name")
  })
  it("is empty without terms", () => {
    expect(buildSuggestions({ terms: [], resources: [], events: [ev("e1")], go })).toEqual([])
  })
})
