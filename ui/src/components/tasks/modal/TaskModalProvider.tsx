import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useLocation, useSearch } from "wouter"
import type { TimelineEvent } from "../../../api/types"

const PARAM = "task"

export interface TaskModal {
  /** The task whose modal is open, from `?task=<id>`; null when none (or the param is malformed). */
  openId: number | null
  /**
   * Opens a task. `error` is shown in the modal when it opens, for a caller
   * that reopens a task after a failed action (a delete that didn't happen).
   * `event`, a feed row's event of this task, opens the modal on its Activity
   * tab with that event's details stacked on top. It is held here, not in the
   * URL: a refresh or a link reopens the task alone.
   */
  open(id: number, opts?: { error?: string; event?: TimelineEvent }): void
  close(): void
  /** The error handed to `open` for the task that is open now, if any. */
  notice: string | null
  clearNotice(): void
  /** The event handed to `open` for the task that is open now, until the modal takes it. */
  focusEvent: TimelineEvent | null
  clearFocusEvent(): void
}

const Ctx = createContext<TaskModal | null>(null)

function parseId(raw: string | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n > 0 ? n : null
}

/**
 * The open task modal lives in the URL as `?task=<id>`, so it is linkable,
 * survives a refresh, and the browser's Back button closes it. Other params
 * (the selected resource, its tab, the home worktree) are preserved, the same
 * way useSelectedResource writes its param.
 *
 * Closing undoes the open rather than adding to history: when `open` pushed
 * the entry, close goes back, so Back afterwards doesn't reopen the modal;
 * when the modal came from a deep link or a refresh there is nothing of ours
 * to go back to (it could leave the app), so close replaces the URL.
 */
export function TaskModalProvider({ children }: { children: ReactNode }) {
  const search = useSearch()
  const [, navigate] = useLocation()
  // Set while a close is waiting on history.back(), whose popstate arrives
  // later: the modal reads as closed at once, until the URL changes.
  const [closingSearch, setClosingSearch] = useState<string | null>(null)
  const parsed = parseId(new URLSearchParams(search).get(PARAM))
  const openId = closingSearch !== null && closingSearch === search ? null : parsed
  // Whether the current open came from our own push (so close can go back).
  const pushed = useRef(false)
  const [pending, setPending] = useState<{ id: number; error: string } | null>(null)
  const [pendingEvent, setPendingEvent] = useState<{ id: number; event: TimelineEvent } | null>(null)

  useEffect(() => {
    if (closingSearch !== null && closingSearch !== search) setClosingSearch(null)
  }, [search, closingSearch])
  useEffect(() => {
    // Closed by any route — our close, the Back button, a link elsewhere.
    // A held event goes too, or ?task= coming back (Forward, a link) would
    // stack its details again.
    if (parsed !== null) return
    pushed.current = false
    setPendingEvent(null)
  }, [parsed])

  // Reads the URL as it is NOW, not as of the last render: a delete's failure
  // path calls open() long after it started, and must not navigate back to
  // whatever page was showing then.
  const setParam = useCallback(
    (value: string | null, replace: boolean) => {
      const params = new URLSearchParams(window.location.search)
      if (value === null) params.delete(PARAM)
      else params.set(PARAM, value)
      const qs = params.toString()
      const path = window.location.pathname
      navigate(qs ? `${path}?${qs}` : path, { replace })
    },
    [navigate],
  )

  const open = useCallback(
    (id: number, opts?: { error?: string; event?: TimelineEvent }) => {
      setPending(opts?.error ? { id, error: opts.error } : null)
      setPendingEvent(opts?.event ? { id, event: opts.event } : null)
      setClosingSearch(null)
      const alreadyOpen = parseId(new URLSearchParams(window.location.search).get(PARAM)) !== null
      // Switching tasks inside an open modal replaces, so a single close
      // still steps back to the page the modal was opened from.
      if (alreadyOpen) {
        setParam(String(id), true)
      } else {
        setParam(String(id), false)
        pushed.current = true
      }
    },
    [setParam],
  )

  const close = useCallback(() => {
    setPending(null)
    setPendingEvent(null)
    if (pushed.current) {
      pushed.current = false
      setClosingSearch(window.location.search.replace(/^\?/, ""))
      window.history.back()
    } else {
      setParam(null, true)
    }
  }, [setParam])

  const notice = pending && pending.id === openId ? pending.error : null
  const clearNotice = useCallback(() => setPending(null), [])
  const focusEvent = pendingEvent && pendingEvent.id === openId ? pendingEvent.event : null
  const clearFocusEvent = useCallback(() => setPendingEvent(null), [])
  const value = useMemo(
    () => ({ openId, open, close, notice, clearNotice, focusEvent, clearFocusEvent }),
    [openId, open, close, notice, clearNotice, focusEvent, clearFocusEvent],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Opens and closes the single task detail modal mounted in App. */
export function useTaskModal(): TaskModal {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useTaskModal must be used inside TaskModalProvider")
  return ctx
}
