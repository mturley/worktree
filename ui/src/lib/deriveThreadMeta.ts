// Pure derivation of the "at a glance" thread facts shared by the active
// ThreadView header and the background-tab summaries in TabBar: who started
// the thread, which channel it's in, when it started, when it was last
// active, and whether it has unread messages. Kept as a single function so
// both call sites can never drift from each other.

import type { ThreadResponse } from '../api/slackApi'

export interface ThreadMeta {
  author?: string
  channelName?: string
  startedTs?: string
  activeTs?: string
  hasUnread: boolean
  /** Plain-text preview of the thread's first (root) message, used as the
   * fallback title when the tab/thread has no custom name. */
  firstMessageText?: string
}

export function deriveThreadMeta(resp: ThreadResponse): ThreadMeta {
  const rootMessage = resp.messages[0]
  const rootUser = rootMessage ? resp.users[rootMessage.UserID] : undefined
  const author = rootUser?.DisplayName || rootUser?.RealName || rootMessage?.UserID || undefined

  const lastMessage = resp.messages[resp.messages.length - 1]
  const startedTs = resp.rootTs || rootMessage?.TS || undefined
  const activeTs = resp.latestReply || lastMessage?.TS || undefined

  return {
    author,
    channelName: resp.channelName || undefined,
    startedTs,
    activeTs,
    hasUnread: resp.unreadIndex >= 0,
    firstMessageText: rootMessage?.Text || undefined,
  }
}
