import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"

export function useSSE() {
  const qc = useQueryClient()
  useEffect(() => {
    let es: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const connect = () => {
      es = new EventSource("/api/stream")
      es.addEventListener("events_new", () => {
        qc.invalidateQueries({ queryKey: ["timeline"] })
        qc.invalidateQueries({ queryKey: ["worktrees"] })
        // Prefix key: matches every ["resources", path]. Resource cards show
        // cached watcher state (PR/Jira status, thread reply counts), which
        // an incoming event has usually just changed — without this they
        // stay stale until a remount forces a refetch.
        qc.invalidateQueries({ queryKey: ["resources"] })
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
