import { useCallback, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { Priority, TaskDetail, TaskState } from "../../../api/types"
import { taskDetailKey, useTaskDetailMutations } from "../../../hooks/useTaskDetail"

export type TaskPatch = { title?: string; description?: string; priority?: Priority; starred?: boolean; due?: string }

/**
 * `update` and `setState` from useTaskDetailMutations, made optimistic: the
 * patched fields are written to the detail cache at once, so the header and
 * sidebar reflect a change before the server replies. On failure only those
 * fields are put back (a concurrent edit to another field survives), and the
 * error is kept for the modal to show. The mutation's own invalidation then
 * refetches the real state either way. Each answers the server's response
 * (a state change's carries its undo_event_id), or undefined on failure.
 */
export function useOptimisticTask(id: number) {
  const qc = useQueryClient()
  const m = useTaskDetailMutations(id)
  const [error, setError] = useState<string | null>(null)

  const optimistic = useCallback(
    async <T,>(fields: Partial<TaskDetail>, call: () => Promise<T>): Promise<T | undefined> => {
      const key = taskDetailKey(id)
      // An in-flight fetch that started before this edit would land the old
      // value on top of the optimistic one.
      void qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<TaskDetail>(key)
      if (prev) qc.setQueryData<TaskDetail>(key, { ...prev, ...fields })
      setError(null)
      try {
        return await call()
      } catch (e) {
        if (prev) {
          const undo = Object.fromEntries(Object.keys(fields).map((k) => [k, prev[k as keyof TaskDetail]]))
          qc.setQueryData<TaskDetail>(key, (cur) => (cur ? { ...cur, ...undo } : cur))
        }
        setError(e instanceof Error ? e.message : "The change could not be saved.")
        return undefined
      }
    },
    [id, qc],
  )

  return {
    error,
    clearError: () => setError(null),
    update: (patch: TaskPatch) =>
      // due "" clears: the DTO omits an empty due, so the cache holds undefined.
      optimistic({ ...patch, ...(patch.due === "" ? { due: undefined } : {}) }, () => m.update(patch)),
    setState: (state: TaskState) => optimistic({ state }, () => m.setState(state)),
    remove: m.remove,
  }
}
