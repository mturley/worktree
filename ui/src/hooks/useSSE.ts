import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import type { NotificationMsg } from "../api/types"
import { TAB_ID } from "../lib/tabId"
import { openNotificationTarget, showBrowserNotification } from "../lib/browserNotify"

/**
 * The stream URL names this tab and where it is, so the server can register
 * it for notifications in the same request that opens the stream.
 */
export function streamUrl(): string {
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
    const connect = () => {
      es = new EventSource(streamUrl())
      es.addEventListener("events_new", () => {
        qc.invalidateQueries({ queryKey: ["timeline"] })
        qc.invalidateQueries({ queryKey: ["worktrees"] })
        // Prefix key: matches every ["resources", path]. Resource cards show
        // cached watcher state (PR/Jira status, thread reply counts), which
        // an incoming event has usually just changed — without this they
        // stay stale until a remount forces a refetch.
        qc.invalidateQueries({ queryKey: ["resources"] })
      })
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
      es.onerror = () => {
        es?.close()
        es = null
        // A stream error can mean the session was revoked on another
        // device. Re-check it: if it's gone, useSession flips to
        // unauthenticated and the login screen shows instead of a tab that
        // looks alive but can't reach anything.
        qc.invalidateQueries({ queryKey: ["session"] })
        timer = setTimeout(connect, 3000)
      }
    }
    connect()
    return () => { es?.close(); if (timer) clearTimeout(timer) }
  }, [qc])
}
