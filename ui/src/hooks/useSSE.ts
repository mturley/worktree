import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import type { CmuxFocusMsg, ListenersSnapshot, NotificationMsg } from "../api/types"
import { isMiniRoute } from "../lib/miniMode"
import { TAB_ID } from "../lib/tabId"
import { emitCmuxFocus } from "../lib/cmuxFocusBus"
import { setListeners } from "../lib/listenersStore"
import { openNotificationTarget, showBrowserNotification } from "../lib/browserNotify"
import { pageHidden, streamsPauseWhenHidden } from "../lib/backgroundStreams"
import { TASK_ACTIVITY_STALE_MS } from "./useTaskDetail"

/**
 * The stream URL names this tab and where it is, so the server can register
 * it for notifications in the same request that opens the stream.
 */
export function streamUrl(): string {
  // The menu bar view is not a browser tab: without `tab` the server never
  // registers it for notifications (internal/webui/stream.go).
  // It also shows no listening ports, so it opts out of that event.
  if (isMiniRoute()) return "/api/stream?listeners=0"
  const params = new URLSearchParams({
    tab: TAB_ID,
    route: window.location.pathname,
    visible: document.visibilityState === "visible" ? "1" : "0",
  })
  return `/api/stream?${params.toString()}`
}

export function useSSE() {
  const qc = useQueryClient()
  useEffect(() => {
    let es: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    // Over plain HTTP a hidden tab gives its connection back; see
    // streamsPauseWhenHidden.
    const pauses = streamsPauseWhenHidden()
    const refreshEvents = () => {
      qc.invalidateQueries({ queryKey: ["timeline"] })
      qc.invalidateQueries({ queryKey: ["worktrees"] })
      // Prefix key: matches every ["resources", path]. Resource cards show
      // cached watcher state (PR/Jira status, thread reply counts), which
      // an incoming event has usually just changed — without this they
      // stay stale until a remount forces a refetch.
      qc.invalidateQueries({ queryKey: ["resources"] })
      // Task changes arrive as their own event, but one missed while hidden
      // is only recovered here.
      refreshTasks()
    }
    // Prefix keys: every scope's lists, the activity feeds (task events ride
    // in them), plus the open-task and unread counts that ride on worktree
    // summaries and resource DTOs.
    const refreshTasks = () => {
      qc.invalidateQueries({ queryKey: ["tasks"], predicate: (q) => q.queryKey[1] !== "activity" })
      refreshActivity()
      qc.invalidateQueries({ queryKey: ["timeline"] })
      qc.invalidateQueries({ queryKey: ["worktrees"] })
      qc.invalidateQueries({ queryKey: ["resources"] })
    }
    // A task's activity feed reads up to 200 events per linked resource, so
    // a burst of stream events must not refetch it once each. A feed fetched
    // within the last TASK_ACTIVITY_STALE_MS is left alone, and refreshed
    // once when that window ends; any other is refreshed now. (Its staleTime
    // alone can't do this: invalidateQueries refetches fresh queries too.)
    let activityTimer: ReturnType<typeof setTimeout> | null = null
    const refreshActivity = () => {
      const now = Date.now()
      const fresh = qc
        .getQueryCache()
        .findAll({ queryKey: ["tasks", "activity"] })
        .filter((q) => now - q.state.dataUpdatedAt < TASK_ACTIVITY_STALE_MS)
      qc.invalidateQueries({ queryKey: ["tasks", "activity"], predicate: (q) => !fresh.includes(q) })
      if (fresh.length > 0 && activityTimer === null) {
        const newest = Math.max(...fresh.map((q) => q.state.dataUpdatedAt))
        activityTimer = setTimeout(() => {
          activityTimer = null
          refreshActivity()
        }, newest + TASK_ACTIVITY_STALE_MS - now)
      }
    }
    const disconnect = () => {
      es?.close()
      es = null
      if (timer) clearTimeout(timer)
      timer = null
      if (activityTimer) clearTimeout(activityTimer)
      activityTimer = null
    }
    const connect = () => {
      es = new EventSource(streamUrl())
      es.addEventListener("events_new", refreshEvents)
      es.addEventListener("tasks_changed", refreshTasks)
      // The server picked this tab to show a notification. Ack either way:
      // shown:false (no permission, no API) sends it on to the next tab at
      // once instead of after the server's timeout.
      es.addEventListener("notification", (e) => {
        let msg: NotificationMsg
        try {
          msg = JSON.parse((e as MessageEvent).data)
        } catch {
          return
        }
        const shown = showBrowserNotification(msg, () => openNotificationTarget(msg))
        void api.tabAck({ tab: TAB_ID, notification_id: msg.id, shown }).catch(() => {})
      })
      // Every tab hears these; CmuxFollower acts on them only in a tab
      // following cmux focus.
      es.addEventListener("cmux_focus", (e) => {
        let msg: CmuxFocusMsg
        try {
          msg = JSON.parse((e as MessageEvent).data)
        } catch {
          return
        }
        // The Switch cmux button reads "Current" from this listing.
        qc.invalidateQueries({ queryKey: ["cmux"] })
        emitCmuxFocus(msg)
      })
      es.addEventListener("listeners_changed", (e) => {
        let snap: ListenersSnapshot
        try {
          snap = JSON.parse((e as MessageEvent).data)
        } catch {
          return
        }
        setListeners(snap)
      })
      es.onerror = () => {
        es?.close()
        es = null
        // A stream error can mean the session was revoked on another
        // device. Re-check it: if it's gone, useSession flips to
        // unauthenticated and the login screen shows instead of a tab that
        // looks alive but can't reach anything.
        qc.invalidateQueries({ queryKey: ["session"] })
        timer = setTimeout(() => {
          timer = null
          if (!(pauses && pageHidden())) connect()
        }, 3000)
      }
    }
    const onVisibility = () => {
      if (pageHidden()) {
        disconnect()
        return
      }
      if (es) return
      disconnect()
      // Whatever arrived while this tab had no stream never reached it.
      refreshEvents()
      qc.invalidateQueries({ queryKey: ["cmux"] })
      connect()
    }
    if (!(pauses && pageHidden())) connect()
    if (pauses) document.addEventListener("visibilitychange", onVisibility)
    return () => {
      if (pauses) document.removeEventListener("visibilitychange", onVisibility)
      disconnect()
    }
  }, [qc])
}
