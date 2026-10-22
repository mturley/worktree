import { useCallback } from "react"
import { notifications } from "@mantine/notifications"
import type { TaskEventSnapshot, TimelineEvent } from "../../api/types"
import { useTaskFromEvent } from "../../hooks/useTaskDetail"
import { eventTaskKey } from "../../lib/taskEventKey"
import { useTaskModal } from "./modal/TaskModalProvider"

/**
 * "＋ task": creates a task from an event, then opens its modal. `path` is
 * the worktree the user acted in (see /api/tasks/from-event). A failure is a
 * toast, since the action's surface (a hover button, a message) has nowhere
 * to say it.
 */
export function useMakeTask(path?: string) {
  const fromEvent = useTaskFromEvent()
  const { open } = useTaskModal()
  return useCallback(
    async (key: string, snapshot?: TaskEventSnapshot) => {
      try {
        const d = await fromEvent(key, snapshot, path)
        open(d.id)
      } catch (err) {
        notifications.show({
          color: "red",
          message: `Couldn't make a task: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    },
    [fromEvent, open, path],
  )
}

/** useMakeTask for a timeline event; its ev: key needs no snapshot (the server builds it). */
export function useMakeTaskFromEvent(path?: string) {
  const make = useMakeTask(path)
  return useCallback(
    (e: TimelineEvent) => {
      const key = eventTaskKey(e)
      if (key) void make(key)
    },
    [make],
  )
}
