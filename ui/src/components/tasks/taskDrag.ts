import { KeyboardSensor, MouseSensor, TouchSensor, type UniqueIdentifier } from "@dnd-kit/core"
import { planDrop, type DropPlan, type TaskSection } from "../../lib/taskSections"
import { PRIORITY_LABEL } from "./TaskPriorityMenu"
import { TASK_STATE_LABEL } from "./TaskStateCheckbox"
/*
 * dnd-kit ids for the task list. Rows are the only draggables and the only
 * drop targets, and a row is "task:<id>".
 */
export const taskDraggableId = (id: number) => `task:${id}`

/**
 * A row's own controls, which keep their presses: a mouse drag never starts
 * on the state checkbox, star or priority mark (.task-row-control) or a link
 * chip that navigates. Everything else drags, the title included: it is a
 * button too, but it only opens the task, as the row itself does.
 */
const ROW_CONTROLS = ".task-row-control, .task-link-chip-nav"

/**
 * Whether a press at `target` may start a drag of `row` (the element the
 * listeners sit on). Only from inside the row's own DOM: React bubbles a
 * portalled menu's or hover card's events up to the row as well. `anywhere`
 * allows the whole row bar its controls; otherwise only the grip.
 */
export function startsRowDrag(target: EventTarget | null, row: EventTarget | null, anywhere: boolean): boolean {
  if (!(target instanceof Element) || !(row instanceof Element) || !row.contains(target)) return false
  if (target.closest("[data-task-grip]")) return true
  return anywhere && !target.closest(ROW_CONTROLS)
}

type Activator<E> = {
  eventName: string
  handler: (event: E, ...rest: never[]) => boolean | undefined
}

/** A sensor's activators, each gated on startsRowDrag. */
function gated<E extends { target: EventTarget | null; currentTarget: EventTarget | null }>(
  activators: readonly Activator<E>[], anywhere: boolean,
) {
  return activators.map((a) => ({
    ...a,
    // Every argument passed on: the keyboard's takes a third (the active drag).
    handler: (event: E, ...rest: never[]) =>
      startsRowDrag(event.target, event.currentTarget, anywhere) && a.handler(event, ...rest),
  }))
}

/**
 * The task list's sensors, whose listeners sit on the whole row. A mouse drag
 * starts anywhere on the row but its controls (past the list's few pixels of
 * travel, so a click still opens the task). Touch and keyboard drags start on
 * the grip only: a swipe across a row must still scroll, and Space or Enter
 * on the star or checkbox must still press it.
 */
export class RowMouseSensor extends MouseSensor {
  static activators = gated(MouseSensor.activators as never, true) as never
}
export class GripTouchSensor extends TouchSensor {
  static activators = gated(TouchSensor.activators as never, false) as never
}
export class GripKeyboardSensor extends KeyboardSensor {
  static activators = gated(KeyboardSensor.activators as never, false) as never
}

function parseTaskId(id: UniqueIdentifier): number | null {
  const m = /^task:(\d+)$/.exec(String(id))
  return m ? Number(m[1]) : null
}

/**
 * Turns dnd-kit's `active`/`over` into planDrop's (section, index). Over a
 * row in the active's own section: the row's index, which is where dnd-kit's
 * sortable shows it landing (arrayMove). Over a row in another section:
 * before that row, or after it when the dragged row's centre is `below` the
 * target's.
 */
export function dropPlanFor(
  sections: TaskSection[], activeId: UniqueIdentifier, overId: UniqueIdentifier, below: boolean,
): DropPlan {
  const active = parseTaskId(activeId)
  if (active === null) return {}
  const over = parseTaskId(overId)
  if (over === null) return {}
  const dest = sections.find((s) => s.tasks.some((t) => t.id === over))
  if (!dest) return {}
  if (dest.tasks.some((t) => t.id === active)) {
    return planDrop(sections, active, dest.key, dest.tasks.findIndex((t) => t.id === over))
  }
  const i = dest.tasks.findIndex((t) => t.id === over)
  return planDrop(sections, active, dest.key, below ? i + 1 : i)
}

/**
 * Where a cross-section drop will land: a line on one edge of a row, and
 * what the drop will change about the task (the plan's patch).
 */
export interface DropIndicator {
  section: string
  id: number
  edge: "before" | "after"
  patch?: DropPlan["patch"]
}

/**
 * A drop's patch in words, for the hint on the section it will land in:
 * "Star"/"Unstar", "Set priority: High"/"Remove priority", "Set state: In
 * progress", joined with " · ". Undefined when the drop changes none.
 */
export function dropHint(patch: DropPlan["patch"]): string | undefined {
  const parts: string[] = []
  if (patch?.starred !== undefined) parts.push(patch.starred ? "Star" : "Unstar")
  if (patch?.priority !== undefined) {
    parts.push(patch.priority === "none" ? "Remove priority" : `Set priority: ${PRIORITY_LABEL[patch.priority]}`)
  }
  if (patch?.state !== undefined) parts.push(`Set state: ${TASK_STATE_LABEL[patch.state]}`)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

/**
 * The landing line for a drag over ANOTHER section, read off the very plan
 * the drop will carry out (dropPlanFor), so the line can't disagree with the
 * drop: `{after: X}` is a line under row X, `{before: X}` one over it.
 *
 * Within the dragged row's own section there is none: there the sortable
 * opens a slot where the row will land, which already says it. A drop that
 * changes nothing shows nothing either.
 */
export function dropIndicatorFor(
  sections: TaskSection[], activeId: UniqueIdentifier, overId: UniqueIdentifier, below: boolean,
): DropIndicator | null {
  const active = parseTaskId(activeId)
  const over = parseTaskId(overId)
  if (active === null || over === null) return null
  const dest = sections.find((s) => s.tasks.some((t) => t.id === over))
  if (!dest || dest.tasks.some((t) => t.id === active)) return null
  const { place, patch } = dropPlanFor(sections, activeId, overId, below)
  if (!place) return null
  const at: DropIndicator = "after" in place
    ? { section: dest.key, id: place.after, edge: "after" }
    : { section: dest.key, id: place.before, edge: "before" }
  return patch ? { ...at, patch } : at
}
