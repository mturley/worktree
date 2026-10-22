import { useCallback } from "react"
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, HttpError } from "../api/client"
import type {
  Priority,
  TaskActivityFilter,
  TaskDetail,
  TaskEventSnapshot,
  TaskLinkTarget,
  TaskState,
} from "../api/types"

/** Both keys sit under the "tasks" root, so the list invalidations refresh them too. */
export const taskDetailKey = (id: number) => ["tasks", "detail", id] as const

export type ActivityQuery = { filter: Exclude<TaskActivityFilter, "resource"> } | { filter: "resource"; type: string; rid: string }

export function taskActivityKey(id: number, q: ActivityQuery): unknown[] {
  return q.filter === "resource"
    ? ["tasks", "activity", id, q.filter, q.type, q.rid]
    : ["tasks", "activity", id, q.filter]
}

/** The task's detail. Disabled while `id` is undefined (no modal open). */
export function useTaskDetail(id: number | undefined) {
  return useQuery({
    queryKey: taskDetailKey(id ?? 0),
    queryFn: () => api.taskDetail(id as number),
    enabled: id !== undefined,
    // A missing (or just deleted) task won't appear on a retry: say so at once.
    retry: (failures, err) => !(err instanceof HttpError && err.status === 404) && failures < 3,
  })
}

/**
 * How long an activity fetch stays fresh. useSSE invalidates every "tasks"
 * query on each events_new and tasks_changed; while fresh, an invalidation
 * only marks the feed stale, so a burst of them costs one refetch rather
 * than one each.
 */
export const TASK_ACTIVITY_STALE_MS = 5000

/** The task's merged activity feed, newest first. */
export function useTaskActivity(id: number | undefined, q: ActivityQuery) {
  return useQuery({
    queryKey: taskActivityKey(id ?? 0, q),
    queryFn: () =>
      api.taskActivity(id as number, q.filter, q.filter === "resource" ? { type: q.type, rid: q.rid } : undefined),
    enabled: id !== undefined,
    staleTime: TASK_ACTIVITY_STALE_MS,
  })
}

type Patch = { title?: string; description?: string; priority?: Priority; starred?: boolean; due?: string }

/** What every task write refreshes: the task lists and the counts on worktrees and resources. */
function settleTaskWrite(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ["tasks"] })
  void qc.invalidateQueries({ queryKey: ["worktrees"] })
  void qc.invalidateQueries({ queryKey: ["resources"] })
}

/**
 * Creates a task from an event and returns its detail, already cached for the
 * modal. For callers with no task yet (a feed row, a Slack message); the
 * caller opens the modal.
 */
export function useTaskFromEvent() {
  const qc = useQueryClient()
  return useCallback(
    async (key: string, snapshot?: TaskEventSnapshot, path?: string) => {
      try {
        const d = await api.taskFromEvent(key, snapshot, path)
        qc.setQueryData(taskDetailKey(d.id), d)
        return d
      } finally {
        settleTaskWrite(qc)
      }
    },
    [qc],
  )
}

export function useTaskDetailMutations(id: number) {
  const qc = useQueryClient()
  const fromEvent = useTaskFromEvent()

  const settle = () => settleTaskWrite(qc)

  /** Runs a call, shows its detail response at once, and settles either way. */
  const run = async (call: () => Promise<TaskDetail>) => {
    try {
      const d = await call()
      qc.setQueryData(taskDetailKey(d.id), d)
      return d
    } finally {
      settle()
    }
  }

  const plain = async <T,>(call: () => Promise<T>) => {
    try {
      return await call()
    } finally {
      settle()
    }
  }

  return {
    update: (patch: Patch) => plain(() => api.updateTask(id, patch)),
    setState: (state: TaskState) => plain(() => api.setTaskState(id, state)),
    remove: () => plain(() => api.deleteTask(id)),
    addLink: (target: { url: string } | TaskLinkTarget, focus?: boolean) =>
      run(() => api.addTaskLink(id, target, focus)),
    removeLink: (t: TaskLinkTarget) => run(() => api.removeTaskLink(id, t)),
    setLinkFocus: (t: TaskLinkTarget, focus: boolean) => run(() => api.setTaskLinkFocus(id, t, focus)),
    orderLinks: (focus: TaskLinkTarget[], related: TaskLinkTarget[]) =>
      run(() => api.orderTaskLinks(id, focus, related)),
    addSubtask: (text: string) => run(() => api.addSubtask(id, text)),
    editSubtask: (subtaskId: number, text: string) => run(() => api.editSubtask(subtaskId, text)),
    checkSubtask: (subtaskId: number, checked: boolean) => run(() => api.checkSubtask(subtaskId, checked)),
    removeSubtask: (subtaskId: number) => run(() => api.removeSubtask(subtaskId)),
    orderSubtasks: (ids: number[]) => run(() => api.orderSubtasks(id, ids)),
    linkEvent: (key: string, snapshot?: TaskEventSnapshot) => run(() => api.linkTaskEvent(id, key, snapshot)),
    unlinkEvent: (key: string) => run(() => api.unlinkTaskEvent(id, key)),
    /** Creates a task from an event and returns its detail; the caller opens the modal. */
    fromEvent,
  }
}
