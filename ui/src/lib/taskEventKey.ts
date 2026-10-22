import type { TaskEventSnapshot, TimelineEvent } from "../api/types"
import type { Message, User } from "../api/slackApi"
import { mrkdwnToPlain } from "./mrkdwnPlain"

/** The most runes of a Slack message's first line a task title takes; mirrors the server. */
const MAX_TITLE = 120

/**
 * Ids that are not watcher events: a task's own events (`task:<n>`, from
 * the server's task timeline) and snapshot rows, whose id is already their
 * link key (`ev:…` / `slack:…`; see LinkedEventsSection).
 */
const NOT_WATCHER = /^(task|ev|slack):/

/**
 * The event-link key of a watcher event (`ev:<id>`), or null for an event
 * that is not one. Watcher ids are opaque strings (UUIDs, in practice), so
 * this goes by what an id is NOT rather than by its shape.
 */
export function eventTaskKey(e: TimelineEvent): string | null {
  if (!e.id || NOT_WATCHER.test(e.id) || e.source === "tasks") return null
  return `ev:${e.id}`
}

/**
 * A Slack message's identity key. Linking a Slack message's watcher event by
 * its ev: key stores it under this one too (the server canonicalises it), so
 * a message has one key however it was linked.
 */
export function slackMessageKey(channel: string, ts: string): string {
  return `slack:${channel}:${ts}`
}

/** A Slack ts ("1700000000.000100") as an RFC 3339 time, as event rows expect; "" if unparseable. */
function slackTsToISO(ts: string): string {
  const secs = Number(ts)
  return Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString() : ""
}

/**
 * The snapshot an event link stores for a Slack message: Slack messages are
 * not watcher events, so the server takes the client's (validated; it sets
 * source and type itself). The title is the first non-blank line of the text
 * as plain text — mentions, channels and links resolved, entities unescaped
 * (the server titles the task the same way); a message with no text is named
 * by its author.
 */
export function slackMessageSnapshot(
  message: Message,
  users: Record<string, User>,
  thread: { channel: string; threadTs: string },
  permalink?: string,
): TaskEventSnapshot {
  const user = users[message.UserID]
  const author = user?.DisplayName || user?.RealName || message.UserID
  const text = message.Text ?? ""
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? ""
  const first = mrkdwnToPlain(line, users).trim()
  const title = first ? Array.from(first).slice(0, MAX_TITLE).join("").trim() : `Message from ${author}`
  return {
    source: "slack",
    type: "slack_reply",
    title,
    author,
    body: text,
    url: permalink ?? "",
    ts: slackTsToISO(message.TS),
    resource_type: "slack",
    resource_id: `${thread.channel}:${thread.threadTs}`,
  }
}
