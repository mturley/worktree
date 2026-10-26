import { keepPreviousData, useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query"
import { api } from "../api/client"
import type { Priority, Task, TaskState } from "../api/types"
import { applyMove } from "../lib/taskSections"

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

export function useTaskMutations(scope: TaskScope) {
  const qc = useQueryClient()
  const scopeKey = taskScopeKey(scope)

  /** Resolves once the task lists' refetch has landed. */
  const settle = () => {
    const tasks = qc.invalidateQueries({ queryKey: ["tasks"] })
    void qc.invalidateQueries({ queryKey: ["worktrees"] })
    void qc.invalidateQueries({ queryKey: ["resources"] })
    return tasks
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
      void settle()
    }
  }

  const update = async (id: number, patch: Patch) => {
    try {
      await api.updateTask(id, patch)
    } finally {
      void settle()
    }
  }

  /** Answers the task, whose undo_event_id (when the state changed) takes it back. */
  const setState = async (id: number, state: TaskState) => {
    try {
      return await api.setTaskState(id, state)
    } finally {
      void settle()
    }
  }

  /**
   * Shows the move in the cache at once, synchronously: the drop's own render
   * must already see it, or the row snaps back for a frame. An in-flight
   * fetch is cancelled first (it would land the old order); cancelling
   * reverts that query synchronously, so the write must come after it.
   *
   * Resolves (or rejects) only once the refetch it triggers has landed, so a
   * caller holding its own optimistic copy (TaskList) knows when the cache
   * has caught up with the server.
   */
  const move = async (id: number, place: Place, patch?: { starred?: boolean; priority?: Priority }) => {
    const cancelled = qc.cancelQueries({ queryKey: scopeKey })
    const snapshot = qc.getQueriesData<Task[]>({ queryKey: scopeKey })
    qc.setQueriesData<Task[]>({ queryKey: scopeKey }, (old) => (old ? applyMove(old, id, place, patch) : old))
    await cancelled
    try {
      if (patch && (patch.starred !== undefined || patch.priority !== undefined)) await api.updateTask(id, patch)
      await api.moveTask(id, place)
    } catch (e) {
      restore(qc, snapshot)
      throw e
    } finally {
      await settle()
    }
  }

  return { create, update, setState, move }
}

function restore(qc: QueryClient, snapshot: [QueryKey, Task[] | undefined][]) {
  for (const [key, data] of snapshot) qc.setQueryData(key, data)
}
