import type { Task, TimelineEvent } from "../api/types"
import { resourceParam } from "./resourceKey"
import { taskWorktreePaths } from "./taskSections"

/*
 * Where the mini view's "Open in full UI" goes: the details over their first
 * worktree's page, or over the home page with none.
 */

function worktreeBase(path: string | undefined): string {
  return path ? `/worktree/${encodeURIComponent(path)}` : "/"
}

export function taskFullUiHref(task: Task): string {
  return `${worktreeBase(taskWorktreePaths(task)[0])}?task=${task.id}`
}

/** A task's event opens as the task, which is what its row does. */
export function eventFullUiHref(e: TimelineEvent): string {
  const path = e.worktree_paths?.[0]
  if (e.resource_type === "task") return `${worktreeBase(path)}?task=${encodeURIComponent(e.resource_id)}`
  const eventParam = `event=${encodeURIComponent(e.id)}`
  if (!path) return `/?${eventParam}`
  return `${worktreeBase(path)}?${resourceParam({ type: e.resource_type, id: e.resource_id })}&${eventParam}`
}
