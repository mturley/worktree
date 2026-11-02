/**
 * The task modal's "Show completed" subtasks choice, remembered per browser.
 *
 * One value for every task: hiding completed subtasks on one carries to the
 * next. On unless it was turned off, including when storage is blocked.
 */
export const SUBTASKS_SHOW_COMPLETED_KEY = "worktree.subtasksShowCompleted"

export function readSubtasksShowCompleted(): boolean {
  try {
    return window.localStorage.getItem(SUBTASKS_SHOW_COMPLETED_KEY) !== "false"
  } catch {
    return true
  }
}

/** Whether the value was saved; false when storage is blocked. */
export function writeSubtasksShowCompleted(value: boolean): boolean {
  try {
    window.localStorage.setItem(SUBTASKS_SHOW_COMPLETED_KEY, value ? "true" : "false")
    return true
  } catch {
    return false
  }
}
