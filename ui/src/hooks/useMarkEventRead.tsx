import { useCallback } from "react"
import { notifications } from "@mantine/notifications"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import type { EventReadChange, MarkUnreadBlocked, TimelineEvent } from "../api/types"
import { showUndoToast, UNDO_WINDOW_MS } from "../components/UndoToast"
import { isArchivedEvent } from "../lib/openEvent"

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
 * Whether an event can be marked unread: the server says it can ever read as
 * unread, and a worktree still follows it, so there is a card to clear it from.
 */
export function canMarkEventUnread(e: TimelineEvent): boolean {
  return !!e.can_mark_unread && !isArchivedEvent(e)
}

const MARK_UNREAD_BLOCKED_TOOLTIPS: Record<MarkUnreadBlocked, string> = {
  own: "This is your own activity, so it never shows as unread.",
  ci_running: "CI is still running. The result will show as unread when it finishes.",
  out_of_date: "This is for an older commit, so it no longer reflects the PR.",
  slack: "Slack tracks read state for the whole thread, not single messages. Use Mark unread from here in the thread view.",
  bookkeeping: "This is a bookkeeping event, so it never shows as unread.",
  own_task: "This is your own change to the task, so it never shows as unread.",
}

const ARCHIVED_TOOLTIP = "No worktree follows this resource any more, so there's nowhere to show it as unread."

/**
 * Why an event can't be marked unread, as the disabled Mark unread button's
 * tooltip, or null when it can be or there is no reason to give (then the
 * button is left out, as before). The server's reason comes first; archived
 * is the client's own rule (see canMarkEventUnread).
 */
export function markUnreadBlockedReason(e: TimelineEvent): string | null {
  if (canMarkEventUnread(e)) return null
  // An unknown code (a newer server) gives no tooltip rather than a wrong one.
  const server = e.mark_unread_blocked ? (MARK_UNREAD_BLOCKED_TOOLTIPS as Record<string, string | undefined>)[e.mark_unread_blocked] : undefined
  if (server) return server
  if (e.can_mark_unread && isArchivedEvent(e)) return ARCHIVED_TOOLTIP
  return null
}

type MarkOptions = { onDone?: () => void; onUndone?: () => void }

/**
 * Writes one event's mark, with no confirmation: `ts` is the row as it was
 * shown, so a CI event rewritten since is refused rather than marked unseen.
 * The usual undo toast takes it back, unless the event already read that way.
 *
 * `onDone` and `onUndone` are for a view holding its own copy of the event, as
 * the details modal does: a feed filtered to unread drops the row, so that copy
 * is never refreshed.
 */
function useEventMark(write: (args: { id: string; ts: string }) => Promise<EventReadChange>, verb: string) {
  const qc = useQueryClient()
  return useCallback(async (e: TimelineEvent, opts: MarkOptions = {}) => {
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: ["tasks"] })
      void qc.invalidateQueries({ queryKey: ["worktrees"] })
      void qc.invalidateQueries({ queryKey: ["resources"] })
      void qc.invalidateQueries({ queryKey: ["timeline"] })
    }
    try {
      const change = await write({ id: e.id, ts: e.ts })
      opts.onDone?.()
      if (change.changed) {
        showUndoToast({
          message: `Marked ${verb}: ${e.title}`,
          undo: async () => {
            await api.restoreEventRead({ id: change.id, ts: change.ts, previous: change.previous })
            opts.onUndone?.()
          },
          onSettled: refresh,
        })
      }
    } catch (err) {
      notifications.show({
        color: "red",
        autoClose: UNDO_WINDOW_MS,
        message: `Couldn't mark ${verb}: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
    refresh()
  }, [qc, write, verb])
}

/** Marks one event read; see useEventMark. */
export const useMarkEventRead = () => useEventMark(api.markEventRead, "read")

/** Marks one event unread, even behind its cursor; see useEventMark. */
export const useMarkEventUnread = () => useEventMark(api.markEventUnread, "unread")
