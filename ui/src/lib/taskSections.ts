import type { Priority, Task, TaskLink, TaskState } from "../api/types"
import { worktreeName } from "./homeWorktree"
import { shortResourceRef } from "./resourceRef"
import { matchTask } from "./search"
import type { ResourceKey } from "./resourceKey"

/*
 * Tasks: pure list logic shared by every task list. No React here.
 * See docs/superpowers/specs/2026-10-21-tasks-design.md, "Ordering" and
 * "The task row". (lib/taskList.ts is unrelated: Markdown checkboxes.)
 */

export type TaskSort = "custom" | "priority" | "state" | "due" | "updated"

export interface TaskListPrefs {
  sort: TaskSort
  showCompleted: boolean
  includeArchived: boolean
  /** In-progress open tasks get their own section, on top of everything. */
  pinInProgress: boolean
  /** Starred open tasks get their own section, below In progress if pinned. */
  pinStarred: boolean
}

export interface TaskSection {
  /**
   * Stable: in_progress, starred, rest, high, medium, low, none, completed;
   * in Priority sort in_progress and starred are split into
   * in_progress:high … in_progress:none and starred:high … starred:none; in
   * State sort rest is split into state:in_progress and state:not_started.
   */
  key: string
  tasks: Task[]
  draggable: boolean
  /** Which pinned group the section belongs to, if any. */
  pin?: TaskPin
  /** What dropping INTO this section implies for the task's star. */
  starred?: boolean
  /** What dropping INTO this section implies for the task's priority. */
  priority?: Priority
  /** What dropping INTO this section implies for the task's state. */
  state?: TaskState
}

/**
 * What a drop changes besides the order. `state` is not an edit: it goes
 * through the state-change API (useTaskMutations.move), like the row's own
 * state picker.
 */
export type TaskPin = "in_progress" | "starred"

export type DropPatch = { starred?: boolean; priority?: Priority; state?: TaskState }

export interface DropPlan {
  place?: { after: number } | { before: number }
  patch?: DropPatch
}

/** Priority sort's groups, in display order. */
const PRIORITY_SECTIONS: Priority[] = ["high", "medium", "low", "none"]

/** State sort's open groups, in display order. */
const STATE_SECTIONS: TaskState[] = ["in_progress", "not_started"]

/** Dragging rewrites the master order, so it only makes sense where it is shown. */
export function canDrag(sort: TaskSort): boolean {
  return sort === "custom" || sort === "priority" || sort === "state"
}

/**
 * The open tasks by state, for the collapsed panel's summary: "2 in progress,
 * 8 not started", leaving out a state with none, or "none open".
 */
export function openSummary(tasks: Task[]): string {
  const inProgress = tasks.filter((t) => t.state === "in_progress").length
  const notStarted = tasks.filter((t) => t.state === "not_started").length
  const parts = [
    inProgress > 0 ? `${inProgress} in progress` : "",
    notStarted > 0 ? `${notStarted} not started` : "",
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(", ") : "none open"
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

/** In progress above not started, master order within each. */
function byState(a: Task, b: Task): number {
  return STATE_SECTIONS.indexOf(a.state) - STATE_SECTIONS.indexOf(b.state) || byMaster(a, b)
}

function byUpdated(a: Task, b: Task): number {
  return cmpStr(b.updated_at, a.updated_at) || byMaster(a, b)
}

function byCompleted(a: Task, b: Task): number {
  return cmpStr(b.completed_at ?? "", a.completed_at ?? "") || byMaster(a, b)
}

const SORTS: Record<TaskSort, (a: Task, b: Task) => number> = {
  custom: byMaster, priority: byMaster, state: byState, due: byDue, updated: byUpdated,
}

/**
 * Groups and orders a task list for display. With pinInProgress, in-progress
 * open tasks are on top and appear only there (starred or not); with
 * pinStarred, the remaining starred open tasks come next and appear only
 * there. In Priority sort each pinned group is itself split by priority
 * (in_progress:high … in_progress:none, starred:high … starred:none, ahead
 * of the unpinned groups), and every one of those sections is returned even
 * when empty (TaskList renders only sections that hold tasks). In State sort
 * a pinned group stays one section, and the rest splits into
 * state:in_progress then state:not_started, each in master order (with In
 * progress pinned, only state:not_started). Completed is last, newest first,
 * when shown.
 *
 * A pin also says what a drop implies: below a pinned In progress every open
 * section holds only not-started tasks, so dropping into one sets that
 * state; with Starred unpinned the other sections leave the star alone.
 */
export function buildSections(tasks: Task[], prefs: TaskListPrefs, terms: string[]): TaskSection[] {
  // Archived gates only done tasks: an open task whose links are all
  // orphaned still shows (marked archived), matching the server.
  const visible = tasks.filter((t) =>
    (prefs.includeArchived || !t.archived || t.state !== "done") &&
    (terms.length === 0 || matchTask(t, terms) !== null),
  )
  const cmp = SORTS[prefs.sort]
  const open = visible.filter((t) => t.state !== "done").sort(cmp)
  const draggable = canDrag(prefs.sort)
  const sections: TaskSection[] = []

  // Below a pinned In progress, what remains open is not started.
  const restState: TaskState | undefined = prefs.pinInProgress ? "not_started" : undefined
  // A pinned group: split by priority in Priority sort, else one section.
  const pinned = (pin: TaskPin, ts: Task[], implies: Pick<TaskSection, "starred" | "state">) => {
    if (prefs.sort === "priority") {
      // Split by priority too, so a drop into it can set both.
      for (const p of PRIORITY_SECTIONS) {
        sections.push({
          key: `${pin}:${p}`, tasks: ts.filter((t) => t.priority === p),
          draggable, pin, ...implies, priority: p,
        })
      }
    } else if (ts.length > 0 || draggable) {
      // Returned empty too while dragging is possible; TaskList hides it then.
      sections.push({ key: pin, tasks: ts, draggable, pin, ...implies })
    }
  }

  let rest = open
  if (prefs.pinInProgress) {
    pinned("in_progress", rest.filter((t) => t.state === "in_progress"), { state: "in_progress" })
    rest = rest.filter((t) => t.state !== "in_progress")
  }
  if (prefs.pinStarred) {
    pinned("starred", rest.filter((t) => t.starred), { starred: true, state: restState })
    rest = rest.filter((t) => !t.starred)
  }
  const restStarred = prefs.pinStarred ? false : undefined
  if (prefs.sort === "priority") {
    for (const p of PRIORITY_SECTIONS) {
      sections.push({
        key: p, tasks: rest.filter((t) => t.priority === p),
        draggable, starred: restStarred, priority: p, state: restState,
      })
    }
  } else if (prefs.sort === "state") {
    for (const st of STATE_SECTIONS) {
      // Under a pinned In progress it would always be empty.
      if (prefs.pinInProgress && st === "in_progress") continue
      sections.push({
        key: `state:${st}`, tasks: rest.filter((t) => t.state === st),
        draggable, starred: restStarred, state: st,
      })
    }
  } else {
    sections.push({ key: "rest", tasks: rest, draggable, starred: restStarred, state: restState })
  }

  if (prefs.showCompleted) {
    sections.push({
      key: "completed",
      tasks: visible.filter((t) => t.state === "done").sort(byCompleted),
      draggable: false,
    })
  }
  return sections
}

/**
 * The task quick add places a new task after. In the draggable sorts the
 * display IS master order, so it is the last visible open task. In Due and
 * Updated the display order means nothing in master order, so it
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
 * above the drop point, else before the one just below. A drop always lands
 * on a row, so the destination holds another task; with none there is no
 * place, and nothing changes.
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
    if (dest.state !== undefined && dest.state !== active.state) patch.state = dest.state
  }

  const others = dest.tasks.filter((t) => t.id !== activeId)
  if (others.length === 0) return {}
  const i = Math.max(0, Math.min(toIndex, others.length))
  // Dropped back at its own index: the order is unchanged.
  if (dest === from && dest.tasks.indexOf(active) === i) return {}

  const plan: DropPlan = { place: i > 0 ? { after: others[i - 1].id } : { before: others[0].id } }
  if (Object.keys(patch).length > 0) plan.patch = patch
  return plan
}

/**
 * A move as the list will show it once the server has made it: task `id`
 * placed next to its target in master order, with `patch` applied. Display
 * order follows `rank`, not array position, so moving the task in the array
 * would change nothing on screen: every task is re-ranked instead, in its new
 * master order. The ranks are stand-ins, meaningful only against each other,
 * and last until the next fetch brings the server's. Unknown task: the list
 * as given. Unknown target: the patch alone.
 */
export function applyMove(
  list: Task[], id: number, place: { after: number } | { before: number },
  patch?: DropPatch,
): Task[] {
  const moving = list.find((t) => t.id === id)
  if (!moving) return list
  const next = { ...moving, ...patch }
  const rest = list.filter((t) => t.id !== id).sort(byMaster)
  const targetId = "after" in place ? place.after : place.before
  const at = rest.findIndex((t) => t.id === targetId)
  if (at < 0) return list.map((t) => (t.id === id ? next : t))
  rest.splice("after" in place ? at + 1 : at, 0, next)
  // Fixed width, so code-unit order is numeric order.
  return rest.map((t, i) => ({ ...t, rank: String(i).padStart(6, "0") }))
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

/** Where a resource chip goes: a worktree page with that resource selected. */
export interface LinkChipTarget {
  worktree: string
  resource: ResourceKey
}

/**
 * The row's link chip: the first Focus link plus "+N" for every other link,
 * or "🔗 N linked" when none is Focus. Null with no links, or on a
 * resource's or worktree's own list when the first Focus link is that
 * resource or worktree. `worktree` is set when the chip names a worktree
 * (its path), so the row can open that worktree's page. `target` is set when
 * the chip names a resource some worktree follows: the list's own worktree
 * if it is one of them, else the first. An unfollowed (archived) resource
 * and "🔗 N linked" have nowhere to go.
 */
export function linkChip(
  t: Task,
  ownResource?: { type: string; id: string },
  ownWorktree?: string,
): { text: string; archived: boolean; worktree?: string; target?: LinkChipTarget } | null {
  if (t.links.length === 0) return null
  const focus = t.links.find((l) => l.focus)
  if (!focus) return { text: `🔗 ${t.links.length} linked`, archived: false }
  if (ownResource && focus.kind === "resource" &&
    focus.resource_type === ownResource.type && focus.resource_id === ownResource.id) return null
  if (ownWorktree && focus.kind === "worktree" && focus.worktree === ownWorktree) return null
  const more = t.links.length - 1
  const chip = { text: more > 0 ? `${linkText(focus)} +${more}` : linkText(focus), archived: focus.archived }
  if (focus.kind === "worktree") return focus.worktree ? { ...chip, worktree: focus.worktree } : chip
  const followers = focus.worktrees ?? []
  if (!focus.resource_type || !focus.resource_id || followers.length === 0) return chip
  const worktree = ownWorktree && followers.includes(ownWorktree) ? ownWorktree : followers[0]
  return { ...chip, target: { worktree, resource: { type: focus.resource_type, id: focus.resource_id } } }
}
