import { useCallback, useState } from "react"
import type { DiffBase, DiffRange } from "../api/types"

interface Stored {
  base: DiffBase
  range: DiffRange
  listId?: string
}

const DEFAULT: Stored = { base: "merge-base", range: "all" }
const keyFor = (path: string) => `worktree.diffSelection:${path}`

function isRange(v: unknown): v is DiffRange {
  if (v === "all") return true
  const r = v as { from?: unknown; to?: unknown } | null
  return !!r && typeof r === "object" && typeof r.from === "string" && typeof r.to === "string"
}

function read(path: string): Stored {
  try {
    const raw = window.localStorage.getItem(keyFor(path))
    if (!raw) return DEFAULT
    const v = JSON.parse(raw)
    if (!v || (v.base !== "merge-base" && v.base !== "tracking") || !isRange(v.range)) return DEFAULT
    return { base: v.base, range: v.range, listId: typeof v.listId === "string" ? v.listId : undefined }
  } catch {
    return DEFAULT
  }
}

function write(path: string, s: Stored) {
  try {
    window.localStorage.setItem(keyFor(path), JSON.stringify(s))
  } catch {
    // Storage blocked: the selection just lasts for this page view.
  }
}

/**
 * The diff view's base and commit range, remembered per worktree. A range
 * names commits, so it is only meaningful for the commit list it was chosen
 * from: when the list's id changes (new commit, rebase) the range falls back
 * to "all". While the list is still loading (`listId` undefined) the stored
 * range is kept.
 */
export function useDiffSelection(path: string, listId: string | undefined) {
  const [state, setState] = useState<{ path: string; stored: Stored }>(() => ({ path, stored: read(path) }))
  // Another worktree: reload its saved selection during render, so there is
  // no frame showing the previous worktree's range.
  let stored = state.stored
  if (state.path !== path) {
    stored = read(path)
    setState({ path, stored })
  }

  const stale = listId !== undefined && stored.listId !== undefined && stored.listId !== listId
  const range: DiffRange = stale ? "all" : stored.range

  const commit = useCallback(
    (next: Stored) => {
      write(path, next)
      setState({ path, stored: next })
    },
    [path],
  )
  const effectiveListId = listId ?? stored.listId
  const setBase = useCallback(
    (base: DiffBase) => commit({ base, range: "all", listId: effectiveListId }),
    [commit, effectiveListId],
  )
  const setRange = useCallback(
    (r: DiffRange) => commit({ base: stored.base, range: r, listId: effectiveListId }),
    [commit, stored.base, effectiveListId],
  )

  return { base: stored.base, range, setBase, setRange }
}
