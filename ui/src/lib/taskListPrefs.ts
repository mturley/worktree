import type { TaskListPrefs, TaskSort } from "./taskSections"

/**
 * The task lists' view choices, remembered per browser: sort, priority
 * filter, show completed, include archived, and whether the task panel is
 * collapsed.
 *
 * ONE value for every task list on every page (collapsed is a single global
 * preference), so one JSON key. localStorage, like unreadOnlyPref.ts: a new
 * tab should keep it.
 */
export const TASK_LIST_KEY = "worktree.taskList"

export type StoredTaskListPrefs = TaskListPrefs & { collapsed: boolean }

export const DEFAULT_TASK_LIST_PREFS: StoredTaskListPrefs = {
  sort: "custom",
  showCompleted: false,
  includeArchived: false,
  collapsed: false,
}

const SORTS: readonly TaskSort[] = ["custom", "priority", "due", "updated"]

/** Stored values over the defaults, each field checked on its own: a bad one falls back alone. */
export function parseTaskListPrefs(raw: string | null): StoredTaskListPrefs {
  const out = { ...DEFAULT_TASK_LIST_PREFS }
  if (!raw) return out
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return out
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out
  const o = v as Record<string, unknown>
  if (SORTS.includes(o.sort as TaskSort)) out.sort = o.sort as TaskSort
  if (typeof o.showCompleted === "boolean") out.showCompleted = o.showCompleted
  if (typeof o.includeArchived === "boolean") out.includeArchived = o.includeArchived
  if (typeof o.collapsed === "boolean") out.collapsed = o.collapsed
  return out
}

/** The raw stored string, or undefined when storage is blocked (private windows throw). */
export function readTaskListPrefsRaw(): string | null | undefined {
  try {
    return window.localStorage.getItem(TASK_LIST_KEY)
  } catch {
    return undefined
  }
}

/** The saved prefs, or the defaults when nothing usable is saved or storage is blocked. */
export function readTaskListPrefs(): StoredTaskListPrefs {
  return parseTaskListPrefs(readTaskListPrefsRaw() ?? null)
}

/** Whether the prefs were saved; false when storage is blocked. */
export function writeTaskListPrefs(p: StoredTaskListPrefs): boolean {
  try {
    window.localStorage.setItem(TASK_LIST_KEY, JSON.stringify(p))
    return true
  } catch {
    return false
  }
}
