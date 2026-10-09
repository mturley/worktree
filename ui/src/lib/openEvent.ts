import type { TimelineEvent } from "../api/types"

/**
 * Carries a timeline event from the home page's activity feed to the worktree
 * page it navigates to, so that page can open the event's details on arrival.
 *
 * History state rather than a URL param: the home page already holds the whole
 * event, and there is no API to fetch one event by id — a param would have to
 * be resolved against the worktree feed, which is paginated and may not have
 * loaded that event at all.
 */
const KEY = "openEvent"

/** The `state` to navigate with. */
export function openEventState(e: TimelineEvent): Record<string, unknown> {
  return { [KEY]: e }
}

/**
 * The event the current history entry asks to open, if any. Validated, not
 * trusted: history state survives reloads and could be anything another page
 * left there.
 */
export function readOpenEvent(): TimelineEvent | null {
  const state: unknown = window.history.state
  if (!state || typeof state !== "object") return null
  const e = (state as Record<string, unknown>)[KEY]
  if (!e || typeof e !== "object") return null
  const ev = e as Partial<TimelineEvent>
  if (typeof ev.id !== "string" || typeof ev.type !== "string" || !Array.isArray(ev.worktrees)) return null
  return e as TimelineEvent
}

/**
 * A request to bring one Slack message into view in its thread.
 *
 * A Slack event IS a message, and the thread view shows it in full and in
 * context — so following one goes to the message rather than to a details
 * modal over the thread. `key` changes on every request, so following the
 * same event twice flashes it twice.
 */
export interface MessageFocus { type: string; id: string; ts: string; key: number }

let focusSeq = 0

/**
 * The message focus an event asks for, or null for anything that is not a
 * Slack message. A Slack event's external_ts is the message's own Slack ts;
 * one without it (a watcher error, say) has no message to go to.
 */
export function messageFocus(e: TimelineEvent): MessageFocus | null {
  if (e.resource_type !== "slack" || !e.resource_id || !e.external_ts) return null
  focusSeq += 1
  return { type: e.resource_type, id: e.resource_id, ts: e.external_ts, key: focusSeq }
}

/**
 * Drops the event from the current history entry, leaving the URL alone, so a
 * reload or a later back/forward onto this entry does not reopen it.
 */
export function clearOpenEvent(): void {
  const state: unknown = window.history.state
  if (!state || typeof state !== "object" || !(KEY in state)) return
  const rest = { ...(state as Record<string, unknown>) }
  delete rest[KEY]
  window.history.replaceState(rest, "")
}
