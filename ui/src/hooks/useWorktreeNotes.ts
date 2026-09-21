import { useCallback, useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
import type { CmuxSyncOutcome } from "../api/types"

/** How long typing must pause before a save is sent. */
export const NOTES_SAVE_DEBOUNCE_MS = 800

export type NotesSaveStatus = "idle" | "unsaved" | "saving" | "saved" | "error"

interface Snapshot { notes: string; sync: boolean }

const same = (a: Snapshot | null, b: Snapshot | null) =>
  !!a && !!b && a.notes === b.notes && a.sync === b.sync

/**
 * A worktree's notes, auto-saved as they are typed.
 *
 * The server copy is adopted ONCE, when it first loads. After that the local
 * draft is the truth: a refetch arriving mid-typing must never replace what
 * the user just wrote. Callers must remount (key by path) to switch worktrees.
 *
 * At most one save is in flight. Edits made during a save are sent by a
 * follow-up save when it returns, so the last keystroke always lands.
 */
export function useWorktreeNotes(path: string) {
  const query = useQuery({
    queryKey: ["worktree-notes", path],
    queryFn: () => api.worktreeNotes(path),
    enabled: !!path,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  const [draft, setDraft] = useState<Snapshot | null>(null)
  const [status, setStatus] = useState<NotesSaveStatus>("idle")
  const [error, setError] = useState<string>()
  const [cmux, setCmux] = useState<{ outcome: CmuxSyncOutcome; error?: string }>()

  const latest = useRef<Snapshot | null>(null)
  const saved = useRef<Snapshot | null>(null)
  const inFlight = useRef(false)
  const again = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (!query.data || latest.current) return
    const s = { notes: query.data.notes, sync: query.data.sync_cmux }
    latest.current = s
    saved.current = s
    setDraft(s)
  }, [query.data])

  const save = useCallback(async (force = false): Promise<void> => {
    clearTimeout(timer.current)
    const snap = latest.current
    if (!snap) return
    if (inFlight.current) {
      again.current = true
      return
    }
    if (!force && same(snap, saved.current)) {
      setStatus((s) => (s === "unsaved" ? "saved" : s))
      return
    }
    inFlight.current = true
    again.current = false
    setStatus("saving")
    try {
      const res = await api.saveWorktreeNotes({ path, notes: snap.notes, sync_cmux: snap.sync })
      saved.current = snap
      inFlight.current = false
      setError(undefined)
      setCmux({ outcome: res.cmux_sync, error: res.cmux_error })
      if (again.current || !same(latest.current, snap)) {
        void save()
      } else {
        setStatus("saved")
      }
    } catch (e) {
      inFlight.current = false
      setError(e instanceof Error ? e.message : String(e))
      setStatus("error")
    }
  }, [path])

  const setNotes = useCallback((notes: string) => {
    if (!latest.current) return
    latest.current = { ...latest.current, notes }
    setDraft(latest.current)
    setStatus("unsaved")
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(), NOTES_SAVE_DEBOUNCE_MS)
  }, [save])

  // A deliberate click, not typing: save straight away. Turning sync on
  // therefore pushes the current notes to cmux without waiting for an edit.
  const setSyncCmux = useCallback((sync: boolean) => {
    if (!latest.current) return
    latest.current = { ...latest.current, sync }
    setDraft(latest.current)
    void save()
  }, [save])

  /** Sends pending edits now instead of waiting out the debounce. */
  const flush = useCallback(() => {
    if (!same(latest.current, saved.current)) void save()
  }, [save])

  // Leaving the page (SPA navigation or closing the tab) must not drop the
  // last edits. keepalive lets the request outlive the page.
  useEffect(() => {
    const sendPending = () => {
      const snap = latest.current
      if (!snap || same(snap, saved.current)) return
      clearTimeout(timer.current)
      api.saveWorktreeNotes({ path, notes: snap.notes, sync_cmux: snap.sync }, { keepalive: true }).catch(() => {})
    }
    window.addEventListener("beforeunload", sendPending)
    return () => {
      window.removeEventListener("beforeunload", sendPending)
      sendPending()
    }
  }, [path])

  return {
    loaded: draft !== null,
    loadError: query.error,
    notes: draft?.notes ?? "",
    syncCmux: draft?.sync ?? false,
    updatedAt: query.data?.updated_at,
    status,
    error,
    cmux,
    setNotes,
    setSyncCmux,
    flush,
    retry: () => void save(true),
  }
}
