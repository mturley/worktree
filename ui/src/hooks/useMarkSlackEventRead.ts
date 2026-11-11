import { useCallback } from "react"
import { notifications } from "@mantine/notifications"
import { useQueryClient } from "@tanstack/react-query"
import { getThread, markRead, restoreRead, type ThreadResponse } from "../api/slackApi"
import type { TimelineEvent } from "../api/types"
import { showUndoToast, UNDO_WINDOW_MS } from "../components/UndoToast"

/** Slack ts values are seconds.micros; compared as numbers, never as strings (they grow a digit). */
const tsAfter = (a: string, b: string) => parseFloat(a) > parseFloat(b)

/** The thread a Slack event belongs to, from its resource id ("C123:1700000000.000100"). */
export function slackEventThread(e: TimelineEvent): { channel: string; threadTs: string } | null {
  if (e.resource_type !== "slack") return null
  const idx = e.resource_id.indexOf(":")
  if (idx <= 0 || idx === e.resource_id.length - 1) return null
  return { channel: e.resource_id.slice(0, idx), threadTs: e.resource_id.slice(idx + 1) }
}

/**
 * Whether a Slack message's details modal offers Mark read. Slack keeps one
 * cursor per thread, so this marks the thread read THROUGH the message
 * (`external_ts`, the message's Slack ts), older unread messages included.
 */
export function canMarkSlackEventRead(e: TimelineEvent): boolean {
  return !!e.unread && !!e.external_ts && !!slackEventThread(e)
}

/**
 * How many messages older than `ts` are unread in the live thread: after
 * Slack's cursor (every message, for a thread never read), not the user's
 * own. These are what marking `ts` read also marks read.
 */
export function olderUnreadCount(thread: Pick<ThreadResponse, "messages" | "lastRead" | "currentUserId">, ts: string): number {
  return thread.messages.filter((m) =>
    tsAfter(ts, m.TS) &&
    (!thread.lastRead || tsAfter(m.TS, thread.lastRead)) &&
    m.UserID !== thread.currentUserId,
  ).length
}

/** What a Slack mark needs: Slack's live cursor before it, and the older unread it would clear. */
export interface SlackMarkPlan {
  lastRead: string
  older: number
  /** The message already reads as read in Slack (the thread was read elsewhere since). */
  alreadyRead: boolean
}

const fail = (err: unknown) =>
  notifications.show({
    color: "red",
    autoClose: UNDO_WINDOW_MS,
    message: `Couldn't mark read: ${err instanceof Error ? err.message : String(err)}`,
  })

type MarkOptions = { onDone?: () => void; onUndone?: () => void }

/**
 * Marks a Slack message read, which in Slack means its whole thread through
 * that message. `plan` fetches the live thread to learn the cursor and how
 * many older messages would go with it, so the caller can warn first; `mark`
 * writes it, with the usual undo toast, which puts Slack's cursor back where
 * `plan` found it (`/api/thread/restore-read`: refused if read further since).
 */
export function useMarkSlackEventRead() {
  const qc = useQueryClient()
  // "tasks" too: a linking task's combined unread count includes the thread.
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["tasks"] })
    void qc.invalidateQueries({ queryKey: ["worktrees"] })
    void qc.invalidateQueries({ queryKey: ["resources"] })
    void qc.invalidateQueries({ queryKey: ["timeline"] })
  }, [qc])

  const plan = useCallback(async (e: TimelineEvent): Promise<SlackMarkPlan | null> => {
    const where = slackEventThread(e)
    if (!where) return null
    try {
      const thread = await getThread(where.channel, where.threadTs)
      return {
        lastRead: thread.lastRead,
        older: olderUnreadCount(thread, e.external_ts),
        alreadyRead: !!thread.lastRead && !tsAfter(e.external_ts, thread.lastRead),
      }
    } catch (err) {
      fail(err)
      return null
    }
  }, [])

  const mark = useCallback(async (e: TimelineEvent, p: SlackMarkPlan, opts: MarkOptions = {}) => {
    const where = slackEventThread(e)
    if (!where) return
    const { channel, threadTs } = where
    const through = e.external_ts
    try {
      await markRead(channel, threadTs, through)
      opts.onDone?.()
      showUndoToast({
        message: `Marked read: ${e.title}`,
        undo: async () => {
          await restoreRead(channel, threadTs, p.lastRead, through)
          opts.onUndone?.()
        },
        onSettled: refresh,
      })
    } catch (err) {
      fail(err)
    }
    refresh()
  }, [refresh])

  return { plan, mark, refresh }
}
