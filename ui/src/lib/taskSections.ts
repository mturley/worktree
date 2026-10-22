import type { Priority, Task, TaskLink } from "../api/types"
import { worktreeName } from "./homeWorktree"
import { shortResourceRef } from "./resourceRef"
import { matchTask } from "./search"

/*
 * Tasks: pure list logic shared by every task list. No React here.
 * See docs/superpowers/specs/2026-10-21-tasks-design.md, "Ordering" and
 * "The task row". (lib/taskList.ts is unrelated: Markdown checkboxes.)
 */

export type TaskSort = "custom" | "priority" | "due" | "updated"

export interface TaskListPrefs {
  sort: TaskSort
  priority: Priority | "all"
  showCompleted: boolean
  includeArchived: boolean
}

export interface TaskSection {
  /** Stable: starred, rest, high, medium, low, none, completed. */
  key: string
  label: string
  tasks: Task[]
  draggable: boolean
  /** What dropping INTO this section implies for the task's star. */
  starred?: boolean
  /** What dropping INTO this section implies for the task's priority. */
  priority?: Priority
}

export interface DropPlan {
  place?: { after: number } | { before: number }
  patch?: { starred?: boolean; priority?: Priority }
}

const PRIORITY_SECTIONS: { key: Priority; label: string }[] = [
  { key: "high", label: "High" },
  { key: "medium", label: "Medium" },
  { key: "low", label: "Low" },
  { key: "none", label: "No priority" },
]

/** Dragging rewrites the master order, so it only makes sense where it is shown. */
export function canDrag(sort: TaskSort): boolean {
  return sort === "custom" || sort === "priority"
}

export function openCount(tasks: Task[]): number {
  return tasks.filter((t) => t.state !== "done").length
}

// Plain code-unit comparison: rank is a fractional-index key, so a
// locale-aware compare would misorder it.
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function byMaster(a: Task, b: Task): number {
  return cmpStr(a.rank, b.rank) || a.id - b.id
}

function byDue(a: Task, b: Task): number {
  if (a.due && b.due) return cmpStr(a.due, b.due) || byMaster(a, b)
  if (a.due) return -1
  if (b.due) return 1
  return byMaster(a, b)
}

function byUpdated(a: Task, b: Task): number {
  return cmpStr(b.updated_at, a.updated_at) || byMaster(a, b)
}

function byCompleted(a: Task, b: Task): number {
  return cmpStr(b.completed_at ?? "", a.completed_at ?? "") || byMaster(a, b)
}

const SORTS: Record<TaskSort, (a: Task, b: Task) => number> = {
  custom: byMaster, priority: byMaster, due: byDue, updated: byUpdated,
}

/**
 * Groups and orders a task list for display. Starred open tasks are always
 * on top and appear only there. In Priority sort every priority section is
 * returned even when empty (so it can take a drop), but a priority filter
 * leaves only its own section, since dropping into another would hide the
 * task. Completed is last, newest first, when shown.
 */
export function buildSections(tasks: Task[], prefs: TaskListPrefs, terms: string[]): TaskSection[] {
  // Archived gates only done tasks: an open task whose links are all
  // orphaned still shows (marked archived), matching the server.
  const visible = tasks.filter((t) =>
    (prefs.includeArchived || !t.archived || t.state !== "done") &&
    (prefs.priority === "all" || t.priority === prefs.priority) &&
    (terms.length === 0 || matchTask(t, terms) !== null),
  )
  const cmp = SORTS[prefs.sort]
  const open = visible.filter((t) => t.state !== "done").sort(cmp)
  const draggable = canDrag(prefs.sort)
  const sections: TaskSection[] = []

  const starred = open.filter((t) => t.starred)
  // Empty, it still shows while dragging is possible: it is a drop target.
  if (starred.length > 0 || draggable) {
    sections.push({ key: "starred", label: "Starred", tasks: starred, draggable, starred: true })
  }
  const rest = open.filter((t) => !t.starred)
  if (prefs.sort === "priority") {
    for (const p of PRIORITY_SECTIONS) {
      if (prefs.priority !== "all" && prefs.priority !== p.key) continue
      sections.push({
        key: p.key, label: p.label, tasks: rest.filter((t) => t.priority === p.key),
        draggable, starred: false, priority: p.key,
      })
    }
  } else {
    sections.push({ key: "rest", label: "Tasks", tasks: rest, draggable, starred: false })
  }

  if (prefs.showCompleted) {
    sections.push({
      key: "completed", label: "Completed",
      tasks: visible.filter((t) => t.state === "done").sort(byCompleted),
      draggable: false,
    })
  }
  return sections
}

/**
 * The task quick add places a new task after. In the draggable sorts the
 * display IS master order, so it is the last visible open task. In Due and
 * Recently updated the display order means nothing in master order, so it
 * is the visible open task last in master order instead.
 */
export function quickAddAnchor(sections: TaskSection[], sort: TaskSort): Task | undefined {
  const open = sections.filter((s) => s.key !== "completed").flatMap((s) => s.tasks)
  if (canDrag(sort)) return open.at(-1)
  return open.reduce<Task | undefined>((max, t) => (!max || byMaster(t, max) > 0 ? t : max), undefined)
}

/**
 * Turns a drop into a move and an edit. `toIndex` indexes the destination's
 * tasks as they are WITHOUT the active one. The task goes after the one just
 * above the drop point, else before the one just below; into a section with
 * no other tasks, next to the nearest task in the flattened draggable
 * sections. Completed is never a neighbour: its order isn't master order.
 */
export function planDrop(sections: TaskSection[], activeId: number, toSection: string, toIndex: number): DropPlan {
  const dest = sections.find((s) => s.key === toSection)
  const from = sections.find((s) => s.tasks.some((t) => t.id === activeId))
  if (!dest || !from || !dest.draggable || !from.draggable) return {}
  const active = from.tasks.find((t) => t.id === activeId)!

  const patch: NonNullable<DropPlan["patch"]> = {}
  if (dest !== from) {
    if (dest.starred !== undefined && dest.starred !== active.starred) patch.starred = dest.starred
    if (dest.priority !== undefined && dest.priority !== active.priority) patch.priority = dest.priority
  }

  const others = dest.tasks.filter((t) => t.id !== activeId)
  let place: DropPlan["place"]
  if (others.length > 0) {
    const i = Math.max(0, Math.min(toIndex, others.length))
    // Dropped back at its own index: the order is unchanged.
    if (dest === from && dest.tasks.indexOf(active) === i) return {}
    place = i > 0 ? { after: others[i - 1].id } : { before: others[0].id }
  } else if (dest !== from) {
    const di = sections.indexOf(dest)
    const flat = (ss: TaskSection[]) => ss.filter((s) => s.draggable).flatMap((s) => s.tasks).filter((t) => t.id !== activeId)
    const above = flat(sections.slice(0, di))
    const below = flat(sections.slice(di + 1))
    if (above.length > 0) place = { after: above[above.length - 1].id }
    else if (below.length > 0) place = { before: below[0].id }
  }
  // else: alone in its own section, dropped back there; nothing moves.

  const plan: DropPlan = {}
  if (place) plan.place = place
  if (Object.keys(patch).length > 0) plan.patch = patch
  return plan
}

const DAY_MS = 24 * 60 * 60 * 1000

/** A YYYY-MM-DD as a LOCAL date; `new Date("YYYY-MM-DD")` would be UTC. */
function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  const date = new Date(y, mo, d)
  if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) return null
  return date
}

export function dueLabel(due: string, today: Date): { text: string; tone: "overdue" | "today" | "neutral"; title: string } {
  const date = parseLocalDate(due)
  if (!date) return { text: due, tone: "neutral", title: due }
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  // Rounded, so a DST day of 23 or 25 hours still counts as one.
  const days = Math.round((date.getTime() - start.getTime()) / DAY_MS)
  const title = "Due " + date.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  })
  const plural = (n: number) => `${n} ${n === 1 ? "day" : "days"}`
  if (days < 0) return { text: `Overdue ${plural(-days)}`, tone: "overdue", title }
  if (days === 0) return { text: "Due today", tone: "today", title }
  if (days === 1) return { text: "Due tomorrow", tone: "neutral", title }
  return { text: `${days} days left`, tone: "neutral", title }
}

function linkText(l: TaskLink): string {
  if (l.kind === "worktree") return l.worktree ? `⎇ ${worktreeName(l.worktree)}` : "⎇ worktree"
  const type = l.resource_type ?? ""
  const id = l.resource_id ?? ""
  return shortResourceRef(type, id) || (type === "slack" ? "Slack thread" : id)
}

/**
 * The row's link chip: the first Focus link plus "+N" for every other link,
 * or "🔗 N linked" when none is Focus. Null with no links, or on a
 * resource's own list when the first Focus link is that resource.
 */
export function linkChip(t: Task, ownResource?: { type: string; id: string }): { text: string; archived: boolean } | null {
  if (t.links.length === 0) return null
  const focus = t.links.find((l) => l.focus)
  if (!focus) return { text: `🔗 ${t.links.length} linked`, archived: false }
  if (ownResource && focus.kind === "resource" &&
    focus.resource_type === ownResource.type && focus.resource_id === ownResource.id) return null
  const more = t.links.length - 1
  return { text: more > 0 ? `${linkText(focus)} +${more}` : linkText(focus), archived: focus.archived }
}
