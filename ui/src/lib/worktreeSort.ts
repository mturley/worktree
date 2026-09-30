import type { CmuxWorkspace, WorktreeSummary } from "../api/types"

/** The home page worktree list's sort orders. */
export type SortMode = "cmux" | "activity" | "created" | "name" | "unread"
export type SortDir = "asc" | "desc"

/** Every mode, in the order the picker lists them. */
export const SORT_MODES: readonly SortMode[] = ["cmux", "activity", "created", "name", "unread"]

export function isSortMode(v: unknown): v is SortMode {
  return typeof v === "string" && (SORT_MODES as readonly string[]).includes(v)
}

export interface SortOptions {
  mode: SortMode
  /** Only consulted in "created" mode. */
  createdDir: SortDir
  /** Path -> the worktree's earliest cmux workspace position; see cmuxPositions. */
  cmuxPositions: Record<string, number>
}

/**
 * Each worktree's position in cmux's sidebar: the EARLIEST of its matching
 * workspaces, which is not necessarily the first in its array. Paths with no
 * positioned workspace are absent, which is what sends them to the bottom.
 */
export function cmuxPositions(matches: Record<string, CmuxWorkspace[]> | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [path, list] of Object.entries(matches ?? {})) {
    for (const ws of list) {
      if (typeof ws.index !== "number") continue
      if (!(path in out) || ws.index < out[path]) out[path] = ws.index
    }
  }
  return out
}

/**
 * Picks the mode to show.
 *
 * Returns null while the answer depends on a cmux query that has not come
 * back — the caller then leaves the list in server order rather than flashing
 * "activity" and jumping to "cmux" a moment later. A saved "cmux" falls back
 * to "activity" without the caller overwriting what was saved, so the choice
 * returns on its own once cmux is reachable again.
 */
export function resolveSortMode(saved: SortMode | null, cmuxPending: boolean, cmuxAvailable: boolean): SortMode | null {
  if (saved !== null && saved !== "cmux") return saved
  if (cmuxPending) return null
  return cmuxAvailable ? "cmux" : "activity"
}

type Compare = (a: WorktreeSummary, b: WorktreeSummary) => number

/** Byte-order compare, matching the registry's SQL ORDER BY. */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const byName: Compare = (a, b) =>
  cmpStr(a.repo, b.repo) || cmpStr(a.branch, b.branch) || cmpStr(a.path, b.path)

/** Empty and unparseable timestamps are "missing", never NaN. */
function parseTime(ts: string | undefined): number | undefined {
  if (!ts) return undefined
  const t = Date.parse(ts)
  return Number.isNaN(t) ? undefined : t
}

/** Missing values sort last whichever way the present ones run. */
function missingLast(a: number | undefined, b: number | undefined, dir: SortDir): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return dir === "asc" ? a - b : b - a
}

const byActivity: Compare = (a, b) =>
  missingLast(parseTime(a.latest_event_ts), parseTime(b.latest_event_ts), "desc")

function comparatorFor({ mode, createdDir, cmuxPositions: pos }: SortOptions): Compare {
  switch (mode) {
    case "cmux":
      return (a, b) => missingLast(pos[a.path], pos[b.path], "asc")
    case "activity":
      return byActivity
    case "created":
      return (a, b) => missingLast(parseTime(a.created_at), parseTime(b.created_at), createdDir)
    case "name":
      return () => 0
    case "unread":
      return (a, b) =>
        Number(Boolean(b.has_unread)) - Number(Boolean(a.has_unread)) ||
        (b.unread_count ?? 0) - (a.unread_count ?? 0) ||
        byActivity(a, b)
  }
}

/** Returns a new, sorted array; every mode breaks ties by name. */
export function sortWorktrees(items: WorktreeSummary[], opts: SortOptions): WorktreeSummary[] {
  const primary = comparatorFor(opts)
  return [...items].sort((a, b) => primary(a, b) || byName(a, b))
}
