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
