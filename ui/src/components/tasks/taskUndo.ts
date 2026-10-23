import { useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { TaskState } from "../../api/types"
import { showUndoToast } from "../UndoToast"
import { TASK_STATE_LABEL } from "./TaskStateCheckbox"

/** What an undo toast says for each undoable task write. */
export const taskUndoMessage = {
  state: (title: string, state: TaskState) => `Marked “${title}” ${TASK_STATE_LABEL[state].toLowerCase()}`,
  subtask: (text: string, checked: boolean) => `${checked ? "Checked" : "Unchecked"} “${text}”`,
  deleted: (title: string) => `Deleted “${title}”`,
}

/**
 * Offers to take back an undoable task write (a state change, a subtask
 * check, a delete): given the `undo_event_id` its response carried, shows an
 * undo toast whose Undo posts it to /api/tasks/undo. No id, no toast: a write
 * that changed nothing recorded no event to take back.
 *
 * `afterUndo` runs only once the undo has succeeded (a delete's reopens the
 * modal). A refused undo (409: the task changed since) is reported by the
 * toast's own failure toast, never retried. Either way the task lists and
 * counts refetch.
 */
export function useOfferTaskUndo() {
  const qc = useQueryClient()
  return useCallback(
    (eventId: number | undefined, message: string, afterUndo?: () => void) => {
      if (!eventId) return
      showUndoToast({
        message,
        undo: async () => {
          await api.undoTask(eventId)
          afterUndo?.()
        },
        onSettled: () => {
          void qc.invalidateQueries({ queryKey: ["tasks"] })
          void qc.invalidateQueries({ queryKey: ["worktrees"] })
          void qc.invalidateQueries({ queryKey: ["resources"] })
          void qc.invalidateQueries({ queryKey: ["timeline"] })
        },
      })
    },
    [qc],
  )
}
