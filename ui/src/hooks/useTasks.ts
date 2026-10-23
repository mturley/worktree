import { keepPreviousData, useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query"
import { api } from "../api/client"
import type { Priority, Task, TaskState } from "../api/types"

export type TaskScope =
  | { kind: "all" }
  | { kind: "worktree"; path: string }
  | { kind: "resource"; type: string; id: string }

/** The query key for a scope. Rooted at "tasks", so invalidating ["tasks"] hits every scope. */
export function taskScopeKey(s: TaskScope): unknown[] {
  switch (s.kind) {
    case "all":
      return ["tasks", "all"]
    case "worktree":
      return ["tasks", "worktree", s.path]
    case "resource":
      return ["tasks", "resource", s.type, s.id]
  }
}

/** Whether a task query's key belongs to the scope whose key is `scopeKey`. */
function sameScope(key: readonly unknown[], scopeKey: unknown[]): boolean {
  return scopeKey.every((part, i) => key[i] === part)
}

export function useTasks(scope: TaskScope, opts: { completed: boolean; archived: boolean }) {
  const scopeKey = taskScopeKey(scope)
  return useQuery({
    queryKey: [...scopeKey, { completed: opts.completed, archived: opts.archived }],
    queryFn: () => api.tasks(scope, opts),
    // Toggling Show completed or Include archived changes the key: keep
    // showing the old list meanwhile rather than dropping to "Loading tasks…",
    // which would unmount the list's DndContext. Only within one scope: another
    // worktree's or resource's tasks are not a stand-in for this one's.
    placeholderData: (prev, prevQuery) =>
      prevQuery && sameScope(prevQuery.queryKey, scopeKey) ? keepPreviousData(prev) : undefined,
  })
}

type Place = { after: number } | { before: number }
type Patch = { title?: string; priority?: Priority; starred?: boolean; due?: string }

/** `list` with task `id` moved next to its target, and `patch` applied to it. */
function reorder(list: Task[], id: number, place: Place, patch?: { starred?: boolean; priority?: Priority }): Task[] {
  const moving = list.find((t) => t.id === id)
  if (!moving) return list
  const rest = list.filter((t) => t.id !== id)
  const targetId = "after" in place ? place.after : place.before
  const at = rest.findIndex((t) => t.id === targetId)
  const next = { ...moving, ...patch }
  if (at < 0) return list.map((t) => (t.id === id ? next : t))
  rest.splice("after" in place ? at + 1 : at, 0, next)
  return rest
}

export function useTaskMutations(scope: TaskScope) {
  const qc = useQueryClient()
  const scopeKey = taskScopeKey(scope)

  const settle = () => {
    void qc.invalidateQueries({ queryKey: ["tasks"] })
    void qc.invalidateQueries({ queryKey: ["worktrees"] })
    void qc.invalidateQueries({ queryKey: ["resources"] })
  }

  const create = async (input: { title: string; priority: Priority; starred: boolean; after?: number; before?: number }) => {
    const ctx =
      scope.kind === "worktree"
        ? { path: scope.path }
        : scope.kind === "resource"
          ? { type: scope.type, id: scope.id }
          : {}
    try {
      return await api.createTask({ ...input, ...ctx })
    } finally {
      settle()
    }
  }

  const update = async (id: number, patch: Patch) => {
    try {
      await api.updateTask(id, patch)
    } finally {
      settle()
    }
  }

  /** Answers the task, whose undo_event_id (when the state changed) takes it back. */
  const setState = async (id: number, state: TaskState) => {
    try {
      return await api.setTaskState(id, state)
    } finally {
      settle()
    }
  }

  const move = async (id: number, place: Place, patch?: { starred?: boolean; priority?: Priority }) => {
    await qc.cancelQueries({ queryKey: scopeKey })
    const snapshot = qc.getQueriesData<Task[]>({ queryKey: scopeKey })
    qc.setQueriesData<Task[]>({ queryKey: scopeKey }, (old) => (old ? reorder(old, id, place, patch) : old))
    try {
      if (patch && (patch.starred !== undefined || patch.priority !== undefined)) await api.updateTask(id, patch)
      await api.moveTask(id, place)
    } catch (e) {
      restore(qc, snapshot)
      throw e
    } finally {
      settle()
    }
  }

  return { create, update, setState, move }
}

function restore(qc: QueryClient, snapshot: [QueryKey, Task[] | undefined][]) {
  for (const [key, data] of snapshot) qc.setQueryData(key, data)
}
