import { describe, expect, it } from "vitest"
import type { Task, TaskLink } from "../api/types"
import {
  applyMove, buildSections, canDrag, dueLabel, linkChip, openSummary, planDrop,
  type TaskListPrefs, type TaskSection,
} from "./taskSections"

function mk(id: number, rank: string, over: Partial<Task> = {}): Task {
  return {
    id, ref: `T${id}`, title: `task ${id}`, description: "", state: "not_started", priority: "none",
    starred: false, rank, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    archived: false, links: [], implicit_worktrees: [], subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, blocker_labels: [], ...over,
  }
}

const prefs = (over: Partial<TaskListPrefs> = {}): TaskListPrefs => ({
  sort: "custom", showCompleted: false, includeArchived: false, ...over,
})

const ids = (s: TaskSection | undefined) => s?.tasks.map((t) => t.id)
const keys = (ss: TaskSection[]) => ss.map((s) => s.key)
const sec = (ss: TaskSection[], key: string) => ss.find((s) => s.key === key)
const STARRED_KEYS = ["starred:high", "starred:medium", "starred:low", "starred:none"]

describe("canDrag", () => {
  it("allows custom, priority and state only", () => {
    expect(canDrag("custom")).toBe(true)
    expect(canDrag("priority")).toBe(true)
    expect(canDrag("state")).toBe(true)
    expect(canDrag("due")).toBe(false)
    expect(canDrag("updated")).toBe(false)
  })
})

describe("openSummary", () => {
  it("counts open tasks by state, leaving out a state with none", () => {
    expect(openSummary([
      mk(1, "a"), mk(2, "b", { state: "in_progress" }), mk(3, "c", { state: "done" }), mk(4, "d"),
    ])).toBe("1 in progress, 2 not started")
    expect(openSummary([mk(1, "a", { state: "in_progress" })])).toBe("1 in progress")
    expect(openSummary([mk(1, "a")])).toBe("1 not started")
    expect(openSummary([mk(1, "a", { state: "done" })])).toBe("none open")
    expect(openSummary([])).toBe("none open")
  })
})

describe("buildSections: custom", () => {
  it("returns starred then rest, in rank order (then id), regardless of input order", () => {
    const ss = buildSections([
      mk(3, "c"), mk(1, "b", { starred: true }), mk(2, "a"), mk(5, "b"), mk(4, "a", { starred: true }),
    ], prefs(), [])
    expect(keys(ss)).toEqual(["starred", "rest"])
    expect(ids(sec(ss, "starred"))).toEqual([4, 1])
    expect(ids(sec(ss, "rest"))).toEqual([2, 5, 3])
  })

  it("compares rank as a plain string, not locale-aware", () => {
    const ss = buildSections([mk(1, "a"), mk(2, "Z"), mk(3, "B")], prefs(), [])
    expect(ids(sec(ss, "rest"))).toEqual([3, 2, 1])
  })

  it("keeps an empty starred section while dragging is possible, as a drop target", () => {
    const ss = buildSections([mk(1, "a")], prefs(), [])
    expect(keys(ss)).toEqual(["starred", "rest"])
    expect(ids(sec(ss, "starred"))).toEqual([])
    expect(keys(buildSections([mk(1, "a")], prefs({ sort: "priority" }), []))[0]).toBe("starred:high")
  })

  it("omits an empty starred section where dragging is off", () => {
    expect(keys(buildSections([mk(1, "a")], prefs({ sort: "due" }), []))).toEqual(["rest"])
    expect(keys(buildSections([mk(1, "a")], prefs({ sort: "updated" }), []))).toEqual(["rest"])
  })

  it("keeps rest even when empty", () => {
    const empty = buildSections([], prefs(), [])
    expect(keys(empty)).toEqual(["starred", "rest"])
    expect(ids(sec(empty, "rest"))).toEqual([])
  })

  it("says what dropping into each section implies, and is draggable", () => {
    const ss = buildSections([mk(1, "a", { starred: true }), mk(2, "b")], prefs(), [])
    expect(sec(ss, "starred")).toMatchObject({ starred: true, draggable: true })
    expect(sec(ss, "rest")).toMatchObject({ starred: false, draggable: true })
    expect(sec(ss, "rest")?.priority).toBeUndefined()
  })

  it("leaves done tasks out unless showCompleted", () => {
    const tasks = [mk(1, "a"), mk(2, "b", { state: "done", completed_at: "2026-10-02T00:00:00Z" })]
    expect(keys(buildSections(tasks, prefs(), []))).toEqual(["starred", "rest"])
    expect(ids(sec(buildSections(tasks, prefs(), []), "rest"))).toEqual([1])
  })
})

describe("buildSections: completed", () => {
  const tasks = [
    mk(1, "a"),
    mk(2, "b", { state: "done", completed_at: "2026-10-02T00:00:00Z" }),
    mk(3, "c", { state: "done", completed_at: "2026-10-05T00:00:00Z", starred: true }),
    mk(4, "d", { state: "done", completed_at: "2026-10-03T00:00:00Z", archived: true }),
  ]

  it("holds done tasks newest completed_at first, not draggable, at the bottom", () => {
    const ss = buildSections(tasks, prefs({ showCompleted: true }), [])
    expect(keys(ss)).toEqual(["starred", "rest", "completed"])
    expect(ids(sec(ss, "completed"))).toEqual([3, 2])
    expect(sec(ss, "completed")?.draggable).toBe(false)
  })

  it("adds archived done tasks only with includeArchived", () => {
    const ss = buildSections(tasks, prefs({ showCompleted: true, includeArchived: true }), [])
    expect(ids(sec(ss, "completed"))).toEqual([3, 4, 2])
  })

  it("starred done tasks go only to completed", () => {
    const ss = buildSections(tasks, prefs({ showCompleted: true }), [])
    expect(ids(sec(ss, "starred"))).toEqual([])
  })

  it("comes last in priority sort too", () => {
    const ss = buildSections(tasks, prefs({ sort: "priority", showCompleted: true }), [])
    expect(keys(ss)).toEqual([...STARRED_KEYS, "high", "medium", "low", "none", "completed"])
  })

  it("shows an open archived task (all links orphaned) without includeArchived", () => {
    const ss = buildSections([mk(1, "a", { archived: true }), mk(2, "b", { archived: true, starred: true })], prefs(), [])
    expect(ids(sec(ss, "rest"))).toEqual([1])
    expect(ids(sec(ss, "starred"))).toEqual([2])
  })
})

describe("buildSections: priority", () => {
  const tasks = [
    mk(1, "e", { priority: "high" }),
    mk(2, "d", { priority: "low" }),
    mk(3, "c", { priority: "high", starred: true }),
    mk(4, "b", { priority: "none" }),
    mk(5, "a", { priority: "high" }),
  ]

  it("returns starred by priority, then high/medium/low/none in master order, empty ones included", () => {
    const ss = buildSections(tasks, prefs({ sort: "priority" }), [])
    expect(keys(ss)).toEqual([...STARRED_KEYS, "high", "medium", "low", "none"])
    expect(ids(sec(ss, "starred:high"))).toEqual([3])
    expect(ids(sec(ss, "high"))).toEqual([5, 1])
    expect(ids(sec(ss, "medium"))).toEqual([])
    expect(ids(sec(ss, "low"))).toEqual([2])
    expect(ids(sec(ss, "none"))).toEqual([4])
  })

  it("splits starred tasks by priority, high to none, each in master order", () => {
    const ss = buildSections([
      mk(1, "e", { starred: true, priority: "low" }),
      mk(2, "d", { starred: true }),
      mk(3, "c", { starred: true, priority: "high" }),
      mk(4, "b", { starred: true, priority: "low" }),
      mk(5, "a", { starred: true, priority: "high" }),
      mk(6, "f", { priority: "high" }),
    ], prefs({ sort: "priority" }), [])
    expect(ids(sec(ss, "starred:high"))).toEqual([5, 3])
    expect(ids(sec(ss, "starred:medium"))).toEqual([])
    expect(ids(sec(ss, "starred:low"))).toEqual([4, 1])
    expect(ids(sec(ss, "starred:none"))).toEqual([2])
    expect(ids(sec(ss, "high"))).toEqual([6])
    // Display order: every starred task first, high to none.
    expect(ss.flatMap((s) => s.tasks.map((t) => t.id))).toEqual([5, 3, 4, 1, 2, 6])
    expect(sec(ss, "starred")).toBeUndefined()
  })

  it("splits starred only in Priority sort", () => {
    for (const sort of ["custom", "due", "updated"] as const) {
      const ss = buildSections([mk(1, "a", { starred: true, priority: "high" }), mk(2, "b")], prefs({ sort }), [])
      expect(keys(ss)).toEqual(["starred", "rest"])
    }
  })

  it("marks each section with the star and priority dropping into it implies", () => {
    const ss = buildSections(tasks, prefs({ sort: "priority" }), [])
    for (const p of ["high", "medium", "low", "none"] as const) {
      expect(sec(ss, p)).toMatchObject({ priority: p, starred: false, draggable: true })
      expect(sec(ss, `starred:${p}`)).toMatchObject({ priority: p, starred: true, draggable: true })
    }
  })

})

describe("buildSections: state", () => {
  const tasks = [
    mk(1, "e", { state: "in_progress" }),
    mk(2, "d"),
    mk(3, "c", { starred: true }),
    mk(4, "b", { state: "in_progress" }),
    mk(5, "a"),
    mk(6, "f", { starred: true, state: "in_progress" }),
    mk(7, "g", { state: "done", completed_at: "2026-10-02T00:00:00Z" }),
  ]

  it("returns one Starred (in progress first), then in progress, then not started, each in master order", () => {
    const ss = buildSections(tasks, prefs({ sort: "state", showCompleted: true }), [])
    expect(keys(ss)).toEqual(["starred", "state:in_progress", "state:not_started", "completed"])
    expect(ids(sec(ss, "starred"))).toEqual([6, 3])
    expect(ids(sec(ss, "state:in_progress"))).toEqual([4, 1])
    expect(ids(sec(ss, "state:not_started"))).toEqual([5, 2])
    expect(ids(sec(ss, "completed"))).toEqual([7])
  })

  it("marks each section with the star and state dropping into it implies, all draggable", () => {
    const ss = buildSections(tasks, prefs({ sort: "state" }), [])
    expect(sec(ss, "starred")).toMatchObject({ starred: true, draggable: true })
    expect(sec(ss, "starred")?.state).toBeUndefined()
    expect(sec(ss, "state:in_progress")).toMatchObject({ starred: false, state: "in_progress", draggable: true })
    expect(sec(ss, "state:not_started")).toMatchObject({ starred: false, state: "not_started", draggable: true })
  })

  it("returns the state sections even when empty (TaskList hides them)", () => {
    const ss = buildSections([mk(1, "a")], prefs({ sort: "state" }), [])
    expect(keys(ss)).toEqual(["starred", "state:in_progress", "state:not_started"])
    expect(ids(sec(ss, "state:in_progress"))).toEqual([])
  })
})

describe("buildSections: filters", () => {
  const tasks = [
    mk(1, "a", { priority: "high", title: "Fix OAuth" }),
    mk(2, "b", { priority: "low", title: "oauth docs", starred: true }),
    mk(3, "c", { priority: "high", title: "Other", description: "mentions oauth" }),
    mk(4, "d", { priority: "high", title: "oauth done", state: "done", completed_at: "2026-10-02T00:00:00Z" }),
    mk(5, "e", { priority: "low", title: "low done", state: "done", completed_at: "2026-10-03T00:00:00Z" }),
  ]

  it("applies search terms to every section, over title and description", () => {
    const ss = buildSections(tasks, prefs({ showCompleted: true }), ["oauth"])
    expect(ids(sec(ss, "starred"))).toEqual([2])
    expect(ids(sec(ss, "rest"))).toEqual([1, 3])
    expect(ids(sec(ss, "completed"))).toEqual([4])
  })

  it("a search narrowing to zero results leaves empty sections, no tasks", () => {
    const ss = buildSections(tasks, prefs({ showCompleted: true }), ["zzz"])
    expect(ss.flatMap((s) => s.tasks)).toEqual([])
    expect(keys(ss)).toEqual(["starred", "rest", "completed"])
  })
})

describe("buildSections: due and updated", () => {
  const tasks = [
    mk(1, "a", { due: "2026-10-30", updated_at: "2026-10-03T00:00:00Z" }),
    mk(2, "b", { updated_at: "2026-10-09T00:00:00Z" }),
    mk(3, "c", { due: "2026-10-22", updated_at: "2026-10-01T00:00:00Z" }),
    mk(4, "d", { due: "2026-10-30", updated_at: "2026-10-05T00:00:00Z" }),
    mk(5, "0", { due: "2026-10-30", updated_at: "2026-10-04T00:00:00Z" }),
    mk(6, "e", { starred: true, due: "2026-10-01", updated_at: "2026-10-02T00:00:00Z" }),
  ]

  it("due: ascending, no-due last, ties by rank; starred still on top; not draggable", () => {
    const ss = buildSections(tasks, prefs({ sort: "due" }), [])
    expect(keys(ss)).toEqual(["starred", "rest"])
    expect(ids(sec(ss, "rest"))).toEqual([3, 5, 1, 4, 2])
    expect(ss.every((s) => !s.draggable)).toBe(true)
  })

  it("updated: newest updated_at first", () => {
    const ss = buildSections(tasks, prefs({ sort: "updated" }), [])
    expect(ids(sec(ss, "rest"))).toEqual([2, 4, 5, 1, 3])
    expect(ss.every((s) => !s.draggable)).toBe(true)
  })
})

describe("planDrop", () => {
  // Custom: starred [1, 2], rest [3, 4, 5]
  const custom = buildSections([
    mk(1, "a", { starred: true }), mk(2, "b", { starred: true }), mk(3, "c"), mk(4, "d"), mk(5, "e"),
  ], prefs(), [])

  it("dragging from rest into starred at index 1 stars it and places after starred[0]", () => {
    expect(planDrop(custom, 4, "starred", 1)).toEqual({ place: { after: 1 }, patch: { starred: true } })
  })

  it("dropping at index 0 places before the first task", () => {
    expect(planDrop(custom, 4, "starred", 0)).toEqual({ place: { before: 1 }, patch: { starred: true } })
  })

  it("dropping at the end places after the last task", () => {
    expect(planDrop(custom, 4, "starred", 2)).toEqual({ place: { after: 2 }, patch: { starred: true } })
    // An index past the end is clamped.
    expect(planDrop(custom, 4, "starred", 9)).toEqual({ place: { after: 2 }, patch: { starred: true } })
  })

  it("leaving starred unstars it", () => {
    expect(planDrop(custom, 1, "rest", 0)).toEqual({ place: { before: 3 }, patch: { starred: false } })
  })

  it("a drop within the same section is a pure reorder, indexed without the active task", () => {
    // rest without 3 is [4, 5]; index 1 is between 4 and 5.
    expect(planDrop(custom, 3, "rest", 1)).toEqual({ place: { after: 4 } })
    expect(planDrop(custom, 5, "rest", 0)).toEqual({ place: { before: 3 } })
    expect(planDrop(custom, 3, "rest", 2)).toEqual({ place: { after: 5 } })
  })

  it("a drop that leaves the task where it already is changes nothing", () => {
    // rest is [3, 4, 5]; 4 at index 1 of [3, 5] is after 3, where it is.
    expect(planDrop(custom, 4, "rest", 1)).toEqual({})
    expect(planDrop(custom, 3, "rest", 0)).toEqual({})
    expect(planDrop(custom, 5, "rest", 2)).toEqual({})
  })

  it("into a section with no other tasks: nothing to place against, so nothing", () => {
    // Rows are the only drop targets, so an empty section is never one; a
    // stray call still changes nothing rather than guessing a place.
    const ss = buildSections([mk(3, "c"), mk(4, "d")], prefs(), [])
    expect(ids(sec(ss, "starred"))).toEqual([])
    expect(planDrop(ss, 4, "starred", 0)).toEqual({})
  })

  it("a starred task dropped into a priority section unstars it and sets the priority if it differs", () => {
    const ss = buildSections([
      mk(1, "a", { priority: "high", starred: true }), mk(2, "b", { priority: "high" }), mk(3, "c", { priority: "low" }),
    ], prefs({ sort: "priority" }), [])
    expect(planDrop(ss, 1, "high", 1)).toEqual({ place: { after: 2 }, patch: { starred: false } })
    expect(planDrop(ss, 1, "low", 0)).toEqual({ place: { before: 3 }, patch: { starred: false, priority: "low" } })
  })

  it("an unstarred task dropped into its own priority's starred section only stars it", () => {
    const ss = buildSections([
      mk(1, "a", { priority: "high", starred: true }), mk(2, "b", { priority: "high" }),
    ], prefs({ sort: "priority" }), [])
    expect(planDrop(ss, 2, "starred:high", 1)).toEqual({ place: { after: 1 }, patch: { starred: true } })
  })

  describe("Priority sort's starred sections", () => {
    // starred:high [1], starred:medium [2], starred:low [3], low [4], medium [5]
    const tasks = [
      mk(1, "a", { priority: "high", starred: true }),
      mk(2, "b", { priority: "medium", starred: true }),
      mk(3, "c", { priority: "low", starred: true }),
      mk(4, "d", { priority: "low" }),
      mk(5, "e", { priority: "medium" }),
    ]
    const ss = buildSections(tasks, prefs({ sort: "priority" }), [])

    it("unstarred into starred:medium: stars it and sets its priority", () => {
      expect(planDrop(ss, 4, "starred:medium", 0)).toEqual({ place: { before: 2 }, patch: { starred: true, priority: "medium" } })
    })

    it("starred:high into starred:low: sets its priority only", () => {
      expect(planDrop(ss, 1, "starred:low", 1)).toEqual({ place: { after: 3 }, patch: { priority: "low" } })
    })

    it("starred:low into low: unstars it only", () => {
      expect(planDrop(ss, 3, "low", 0)).toEqual({ place: { before: 4 }, patch: { starred: false } })
    })

    it("starred into another priority's group: unstars it and sets that priority", () => {
      expect(planDrop(ss, 1, "medium", 1)).toEqual({ place: { after: 5 }, patch: { starred: false, priority: "medium" } })
    })

    it("applyMove lands each of those in its new section at once", () => {
      const where = (list: Task[], id: number) =>
        buildSections(list, prefs({ sort: "priority" }), []).find((s) => s.tasks.some((t) => t.id === id))?.key
      const cases: [number, string, number][] = [[4, "starred:medium", 0], [1, "starred:low", 1], [3, "low", 0], [1, "medium", 1]]
      for (const [id, to, i] of cases) {
        const plan = planDrop(ss, id, to, i)
        expect(where(applyMove(tasks, id, plan.place!, plan.patch), id)).toBe(to)
      }
    })
  })

  describe("State sort", () => {
    // starred [1 (in progress), 2], in progress [3, 4], not started [5, 6]
    const tasks = [
      mk(1, "a", { starred: true, state: "in_progress" }),
      mk(2, "b", { starred: true }),
      mk(3, "c", { state: "in_progress" }),
      mk(4, "d", { state: "in_progress" }),
      mk(5, "e"),
      mk(6, "f"),
    ]
    const ss = buildSections(tasks, prefs({ sort: "state" }), [])

    it("not started into in progress: sets its state", () => {
      expect(planDrop(ss, 5, "state:in_progress", 1)).toEqual({ place: { after: 3 }, patch: { state: "in_progress" } })
    })

    it("in progress into not started: sets its state", () => {
      expect(planDrop(ss, 3, "state:not_started", 0)).toEqual({ place: { before: 5 }, patch: { state: "not_started" } })
    })

    it("within a state: a pure reorder", () => {
      expect(planDrop(ss, 5, "state:not_started", 1)).toEqual({ place: { after: 6 } })
    })

    it("into Starred: stars it, state unchanged", () => {
      expect(planDrop(ss, 6, "starred", 0)).toEqual({ place: { before: 1 }, patch: { starred: true } })
    })

    it("out of Starred: unstars it, and sets the state only where it differs", () => {
      expect(planDrop(ss, 1, "state:not_started", 0)).toEqual({ place: { before: 5 }, patch: { starred: false, state: "not_started" } })
      expect(planDrop(ss, 1, "state:in_progress", 0)).toEqual({ place: { before: 3 }, patch: { starred: false } })
    })

    it("applyMove lands each of those in its new section at once", () => {
      const where = (list: Task[], id: number) =>
        buildSections(list, prefs({ sort: "state" }), []).find((s) => s.tasks.some((t) => t.id === id))?.key
      const cases: [number, string, number][] = [
        [5, "state:in_progress", 1], [3, "state:not_started", 0], [6, "starred", 0], [1, "state:not_started", 0],
      ]
      for (const [id, to, i] of cases) {
        const plan = planDrop(ss, id, to, i)
        expect(where(applyMove(tasks, id, plan.place!, plan.patch), id)).toBe(to)
      }
      const plan = planDrop(ss, 5, "state:in_progress", 1)
      const moved = buildSections(applyMove(tasks, 5, plan.place!, plan.patch), prefs({ sort: "state" }), [])
      expect(ids(sec(moved, "state:in_progress"))).toEqual([3, 5, 4])
    })
  })

  it("the only task in its section, dropped back there, changes nothing", () => {
    const ss = buildSections([mk(1, "a", { starred: true }), mk(2, "b")], prefs(), [])
    expect(planDrop(ss, 1, "starred", 0)).toEqual({})
  })

  it("refuses completed, unknown sections, non-draggable sorts and an unknown task", () => {
    const ss = buildSections([
      mk(1, "a"), mk(2, "b", { state: "done", completed_at: "2026-10-02T00:00:00Z" }),
    ], prefs({ showCompleted: true }), [])
    expect(planDrop(ss, 1, "completed", 0)).toEqual({})
    expect(planDrop(ss, 1, "nope", 0)).toEqual({})
    expect(planDrop(ss, 99, "rest", 0)).toEqual({})
    const due = buildSections([mk(1, "a"), mk(2, "b")], prefs({ sort: "due" }), [])
    expect(planDrop(due, 1, "rest", 1)).toEqual({})
  })
})

describe("dueLabel", () => {
  it("labels relative to today's local date", () => {
    expect(dueLabel("2026-10-21", new Date(2026, 9, 21, 23, 59)).text).toBe("Due today")
    expect(dueLabel("2026-10-22", new Date(2026, 9, 21)).text).toBe("Due tomorrow")
    expect(dueLabel("2026-10-24", new Date(2026, 9, 21)).text).toBe("3 days left")
    expect(dueLabel("2026-10-20", new Date(2026, 9, 21))).toMatchObject({ text: "Overdue 1 day", tone: "overdue" })
    expect(dueLabel("2026-11-01", new Date(2026, 9, 31)).text).toBe("Due tomorrow")
  })

  it("uses today's local date even just after midnight", () => {
    expect(dueLabel("2026-10-21", new Date(2026, 9, 21, 0, 1)).text).toBe("Due today")
    expect(dueLabel("2026-10-20", new Date(2026, 9, 21, 0, 1)).text).toBe("Overdue 1 day")
  })

  it("pluralises overdue and sets tones", () => {
    expect(dueLabel("2026-10-18", new Date(2026, 9, 21))).toMatchObject({ text: "Overdue 3 days", tone: "overdue" })
    expect(dueLabel("2026-10-21", new Date(2026, 9, 21)).tone).toBe("today")
    expect(dueLabel("2026-10-22", new Date(2026, 9, 21)).tone).toBe("neutral")
    expect(dueLabel("2026-12-25", new Date(2026, 9, 21))).toMatchObject({ text: "65 days left", tone: "neutral" })
  })

  it("crosses a DST change by whole days", () => {
    // US DST ends 2026-11-01; whole local days, not 24h blocks.
    expect(dueLabel("2026-11-03", new Date(2026, 9, 31, 12)).text).toBe("3 days left")
  })

  it("titles with the absolute date", () => {
    expect(dueLabel("2026-10-24", new Date(2026, 9, 21)).title).toBe("Due Sat, Oct 24, 2026")
  })

  it("falls back to the raw string for an unparsable date", () => {
    expect(dueLabel("soon", new Date(2026, 9, 21))).toEqual({ text: "soon", tone: "neutral", title: "soon" })
    expect(dueLabel("2026-13-45", new Date(2026, 9, 21)).tone).toBe("neutral")
  })
})

describe("linkChip", () => {
  const pr = (focus: boolean, archived = false): TaskLink => ({
    kind: "resource", resource_type: "pr", resource_id: "opendatahub-io/odh-dashboard#4521", focus, archived,
  })
  const jira = (focus: boolean): TaskLink => ({
    kind: "resource", resource_type: "jira", resource_id: "RHOAIENG-1", focus, archived: false,
  })
  const wt = (focus: boolean): TaskLink => ({ kind: "worktree", worktree: "/Users/m/.worktrees/repo/oauth-fix", focus, archived: false })
  const withLinks = (links: TaskLink[]) => mk(1, "a", { links })

  it("is null with no links", () => {
    expect(linkChip(withLinks([]))).toBeNull()
  })

  it("shows the first Focus link plus a count of all others", () => {
    expect(linkChip(withLinks([pr(true), jira(false), wt(false)]))).toEqual({ text: "#4521 +2", archived: false })
    expect(linkChip(withLinks([jira(false), pr(true), wt(true)]))).toEqual({ text: "#4521 +2", archived: false })
    expect(linkChip(withLinks([jira(true)]))).toEqual({ text: "RHOAIENG-1", archived: false })
  })

  it("renders a worktree link as its basename", () => {
    expect(linkChip(withLinks([wt(true), pr(false)]))).toMatchObject({ text: "⎇ oauth-fix +1", archived: false })
  })

  it("names a worktree link with no path generically", () => {
    expect(linkChip(withLinks([{ kind: "worktree", focus: true, archived: false }]))?.text).toBe("⎇ worktree")
  })

  it("shows N linked when nothing is Focus", () => {
    expect(linkChip(withLinks([pr(false), jira(false), wt(false)]))).toEqual({ text: "🔗 3 linked", archived: false })
  })

  it("is archived when the chosen link is", () => {
    expect(linkChip(withLinks([pr(true, true), jira(false)]))).toEqual({ text: "#4521 +1", archived: true })
    expect(linkChip(withLinks([jira(true), pr(false, true)]))?.archived).toBe(false)
  })

  it("is null on the list of the resource its first Focus link names", () => {
    const own = { type: "pr", id: "opendatahub-io/odh-dashboard#4521" }
    expect(linkChip(withLinks([pr(true), jira(false)]), own)).toBeNull()
    expect(linkChip(withLinks([jira(true), pr(true)]), own)).toEqual({ text: "RHOAIENG-1 +1", archived: false })
    expect(linkChip(withLinks([pr(false), jira(false)]), own)).toEqual({ text: "🔗 2 linked", archived: false })
  })

  it("carries a worktree chip's path, so the row can open its page", () => {
    expect(linkChip(withLinks([wt(true)]))?.worktree).toBe("/Users/m/.worktrees/repo/oauth-fix")
    expect(linkChip(withLinks([pr(true), wt(false)]))?.worktree).toBeUndefined()
  })

  it("targets a followed resource chip at a worktree page: the list's own worktree if it follows, else the first", () => {
    const followed = (focus: boolean, worktrees: string[]): TaskLink => ({ ...pr(focus), worktrees })
    const key = { type: "pr", id: "opendatahub-io/odh-dashboard#4521" }
    expect(linkChip(withLinks([followed(true, ["/w/a", "/w/b"])]))).toEqual({
      text: "#4521", archived: false, target: { worktree: "/w/a", resource: key },
    })
    expect(linkChip(withLinks([followed(true, ["/w/a", "/w/b"])]), undefined, "/w/b")?.target).toEqual({ worktree: "/w/b", resource: key })
    expect(linkChip(withLinks([followed(true, ["/w/a", "/w/b"])]), undefined, "/w/c")?.target).toEqual({ worktree: "/w/a", resource: key })
  })

  it("has no target when no worktree follows the resource, or for N linked", () => {
    expect(linkChip(withLinks([{ ...pr(true, true), worktrees: [] }]))?.target).toBeUndefined()
    expect(linkChip(withLinks([pr(true)]))?.target).toBeUndefined()
    expect(linkChip(withLinks([{ ...pr(false), worktrees: ["/w/a"] }, jira(false)]))?.target).toBeUndefined()
    expect(linkChip(withLinks([wt(true)]))?.target).toBeUndefined()
  })

  it("is null on the list of the worktree its first Focus link names", () => {
    const own = "/Users/m/.worktrees/repo/oauth-fix"
    expect(linkChip(withLinks([wt(true), pr(false)]), undefined, own)).toBeNull()
    expect(linkChip(withLinks([wt(true)]), undefined, "/Users/m/.worktrees/repo/other")?.text).toBe("⎇ oauth-fix")
  })

  it("names a Slack thread, which has no short ref", () => {
    const slack: TaskLink = { kind: "resource", resource_type: "slack", resource_id: "C1:1.2", focus: true, archived: false }
    expect(linkChip(withLinks([slack]))?.text).toBe("Slack thread")
  })
})

describe("applyMove", () => {
  const order = (ts: Task[], p: Partial<TaskListPrefs> = {}) =>
    buildSections(ts, prefs(p), []).flatMap((s) => s.tasks.map((t) => t.id))

  it("moves the task in DISPLAY order, which follows rank, not array order", () => {
    const ts = [mk(1, "a"), mk(2, "b"), mk(3, "c")]
    expect(order(applyMove(ts, 3, { after: 1 }))).toEqual([1, 3, 2])
    expect(order(applyMove(ts, 1, { after: 3 }))).toEqual([2, 3, 1])
    expect(order(applyMove(ts, 3, { before: 1 }))).toEqual([3, 1, 2])
  })

  it("places by master order whatever order the array arrives in", () => {
    const ts = [mk(3, "c"), mk(1, "a"), mk(2, "b")]
    expect(order(applyMove(ts, 3, { after: 1 }))).toEqual([1, 3, 2])
  })

  it("applies the patch, so the task shows in its new section", () => {
    const ts = [mk(1, "a", { starred: true }), mk(2, "b"), mk(3, "c")]
    const next = applyMove(ts, 1, { after: 2 }, { starred: false })
    expect(next.find((t) => t.id === 1)?.starred).toBe(false)
    expect(order(next)).toEqual([2, 1, 3])
  })

  it("leaves the input untouched", () => {
    const ts = [mk(1, "a"), mk(2, "b")]
    applyMove(ts, 1, { after: 2 })
    expect(ts.map((t) => [t.id, t.rank])).toEqual([[1, "a"], [2, "b"]])
  })

  it("an unknown task changes nothing; an unknown target only patches", () => {
    const ts = [mk(1, "a"), mk(2, "b")]
    expect(applyMove(ts, 9, { after: 1 })).toBe(ts)
    const next = applyMove(ts, 1, { after: 9 }, { priority: "high" })
    expect(order(next)).toEqual([1, 2])
    expect(next.find((t) => t.id === 1)?.priority).toBe("high")
  })
})
