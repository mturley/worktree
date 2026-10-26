import type { UniqueIdentifier } from "@dnd-kit/core"
import { planDrop, type DropPlan, type TaskSection } from "../../lib/taskSections"

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
