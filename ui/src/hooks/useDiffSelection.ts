import { useCallback, useSyncExternalStore } from "react"
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

function parse(raw: string | null): Stored {
  if (!raw) return DEFAULT
  try {
    const v = JSON.parse(raw)
    if (!v || (v.base !== "merge-base" && v.base !== "tracking") || !isRange(v.range)) return DEFAULT
    return { base: v.base, range: v.range, listId: typeof v.listId === "string" ? v.listId : undefined }
  } catch {
    return DEFAULT
  }
}

// One selection per worktree path, shared by every hook instance (the card's
// badge and the Code tab both read it, so a base change in the tab moves the
// badge). localStorage is the source of truth; `cache` keeps each path's
// parsed value stable for useSyncExternalStore. Each entry records the stored
// string it stands for, so storage changing underneath is noticed, and a write
// storage refused (blocked or full) is kept as long as storage still holds
// what it held then: the selection just lasts for this page view.
const cache = new Map<string, { raw: string | null | undefined; stored: Stored }>()
const listeners = new Map<string, Set<() => void>>()

/** The stored string, or undefined when storage can't be read. */
function readRaw(path: string): string | null | undefined {
  try {
    return window.localStorage.getItem(keyFor(path))
  } catch {
    return undefined
  }
}

function snapshot(path: string): Stored {
  const entry = cache.get(path)
  const raw = readRaw(path)
  if (raw === undefined) return entry?.stored ?? DEFAULT
  if (entry && entry.raw === raw) return entry.stored
  const stored = parse(raw)
  cache.set(path, { raw, stored })
  return stored
}

function write(path: string, stored: Stored) {
  let raw: string | null | undefined = JSON.stringify(stored)
  try {
    window.localStorage.setItem(keyFor(path), raw)
  } catch {
    raw = readRaw(path)
  }
  cache.set(path, { raw, stored })
  listeners.get(path)?.forEach((l) => l())
}

function subscribe(path: string, listener: () => void) {
  let set = listeners.get(path)
  if (!set) listeners.set(path, (set = new Set()))
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(path)
  }
}

/**
 * The diff view's base and commit range, remembered per worktree and shared
 * by every instance for the same path. A range names commits, so it is only
 * meaningful for the commit list it was chosen from: when the list's id
 * changes (new commit, rebase) the range falls back to "all". While the list
 * is still loading (`listId` undefined) the stored range is kept.
 */
export function useDiffSelection(path: string, listId: string | undefined) {
  const sub = useCallback((l: () => void) => subscribe(path, l), [path])
  const get = useCallback(() => snapshot(path), [path])
  const stored = useSyncExternalStore(sub, get)

  const stale = listId !== undefined && stored.listId !== undefined && stored.listId !== listId
  const range: DiffRange = stale ? "all" : stored.range

  const effectiveListId = listId ?? stored.listId
  const setBase = useCallback(
    (base: DiffBase) => write(path, { base, range: "all", listId: effectiveListId }),
    [path, effectiveListId],
  )
  const setRange = useCallback(
    (r: DiffRange) => write(path, { base: snapshot(path).base, range: r, listId: effectiveListId }),
    [path, effectiveListId],
  )

  return { base: stored.base, range, setBase, setRange }
}
