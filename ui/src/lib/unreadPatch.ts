// Pure helper for ThreadView's optimistic "mark unread from here" action:
// given the current messages and the TS the user clicked "mark unread" on,
// compute the new unreadIndex/lastRead pair to apply locally via
// useThread's applyLocal, without waiting for a refetch.

import type { Message } from '../api/slackApi'

export interface UnreadPatch {
  unreadIndex: number
  lastRead: string
}

/**
 * Finds the message with an exact TS match and returns the unreadIndex/
 * lastRead pair that puts the "New" divider directly above that message.
 * `lastRead` is the TS of the message just before it, or "" if it's the
 * very first message. Callers always pass an exact message.TS, but if `ts`
 * isn't found among `messages`, this is a safe no-op: it reports the thread
 * as fully read rather than guessing at a divider position.
 */
export function computeUnreadPatch(messages: Message[], ts: string): UnreadPatch {
  const idx = messages.findIndex((message) => message.TS === ts)
  if (idx === -1) {
    return { unreadIndex: -1, lastRead: '' }
  }
  const lastRead = idx > 0 ? messages[idx - 1].TS : ''
  return { unreadIndex: idx, lastRead }
}
