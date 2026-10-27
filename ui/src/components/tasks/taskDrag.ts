import type { UniqueIdentifier } from "@dnd-kit/core"
import { planDrop, type DropPlan, type TaskSection } from "../../lib/taskSections"
import { PRIORITY_LABEL } from "./TaskPriorityMenu"
import { TASK_STATE_LABEL } from "./TaskStateCheckbox"
/*
 * dnd-kit ids for the task list. Rows are the only draggables and the only
 * drop targets, and a row is "task:<id>".
 */
export const taskDraggableId = (id: number) => `task:${id}`

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
