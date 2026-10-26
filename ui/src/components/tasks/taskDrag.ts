import { closestCenter, type CollisionDetection, type UniqueIdentifier } from "@dnd-kit/core"
import { planDrop, type DropPlan, type TaskSection } from "../../lib/taskSections"

/*
 * dnd-kit ids for the task list. Rows and sections share one DndContext, so
 * their ids are namespaced: a row is "task:<id>", a section's drop area is
 * "section:<key>".
 */
export const taskDraggableId = (id: number) => `task:${id}`
export const sectionDroppableId = (key: string) => `section:${key}`

function parseTaskId(id: UniqueIdentifier): number | null {
  const m = /^task:(\d+)$/.exec(String(id))
  return m ? Number(m[1]) : null
}

function parseSectionKey(id: UniqueIdentifier): string | null {
  const m = /^section:(.+)$/.exec(String(id))
  return m ? m[1] : null
}

/**
 * Turns dnd-kit's `active`/`over` into planDrop's (section, index). Over a
 * section's drop area: its end. Over a row in the active's own section: the
 * row's index, which is where dnd-kit's sortable shows it landing (arrayMove).
 * Over a row in another section: before that row, or after it when the
 * dragged row's centre is `below` the target's.
 */
export function dropPlanFor(
  sections: TaskSection[], activeId: UniqueIdentifier, overId: UniqueIdentifier, below: boolean,
): DropPlan {
  const active = parseTaskId(activeId)
  if (active === null) return {}
  const sectionKey = parseSectionKey(overId)
  if (sectionKey !== null) {
    const dest = sections.find((s) => s.key === sectionKey)
    if (!dest) return {}
    return planDrop(sections, active, dest.key, dest.tasks.filter((t) => t.id !== active).length)
  }
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
 * Nearest row wins. Only non-empty sections render, and a section's area
 * spans its rows, so it never competes with them.
 */
export const taskCollisions: CollisionDetection = (args) =>
  closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) => parseSectionKey(c.id) === null),
  })
