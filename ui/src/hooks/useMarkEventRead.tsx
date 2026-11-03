import { useCallback } from "react"
import { notifications } from "@mantine/notifications"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import type { TimelineEvent } from "../api/types"
import { showUndoToast, UNDO_WINDOW_MS } from "../components/UndoToast"

/**
 * Whether an event can be marked read on its own: the server calls it unread
 * (so never the user's own, a running CI event, or anything behind its
 * cursor), and its read state is worktree's. Slack keeps one cursor per
 * thread and cannot read a single message.
 */
export function canMarkEventRead(e: TimelineEvent): boolean {
  return !!e.unread && e.source !== "slack" && e.resource_type !== "slack"
}

/**
 * Marks one event read, with no confirmation: `ts` is the row as it was
 * shown, so a CI event rewritten since is refused rather than marked unseen.
 * The usual undo toast takes it back, unless the event already read as read.
 *
 * `onRead` and `onUndone` are for a view holding its own copy of the event,
 * as the details modal does: a feed filtered to unread drops the row, so that
 * copy is never refreshed.
 */
export function useMarkEventRead() {
  const qc = useQueryClient()
  return useCallback(async (e: TimelineEvent, opts: { onRead?: () => void; onUndone?: () => void } = {}) => {
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: ["tasks"] })
      void qc.invalidateQueries({ queryKey: ["worktrees"] })
      void qc.invalidateQueries({ queryKey: ["resources"] })
      void qc.invalidateQueries({ queryKey: ["timeline"] })
    }
    try {
      const change = await api.markEventRead({ id: e.id, ts: e.ts })
      opts.onRead?.()
      if (change.changed) {
        showUndoToast({
          message: "Marked event read",
          undo: async () => {
            await api.restoreEventRead({ id: change.id, ts: change.ts })
            opts.onUndone?.()
          },
          onSettled: refresh,
        })
      }
    } catch (err) {
      notifications.show({
        color: "red",
        autoClose: UNDO_WINDOW_MS,
        message: `Couldn't mark read: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
    refresh()
  }, [qc])
}
