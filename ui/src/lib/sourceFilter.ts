import type { WorktreeSummary } from "../api/types"

/**
 * Whether a resource type passes the Activity source toggles. An empty
 * selection is "all sources", not "none".
 */
export function matchesSources(type: string, sources: string[]): boolean {
  return sources.length === 0 || sources.includes(type)
}

/**
 * A home-page worktree card narrowed to the selected sources: its focus
 * resources and related counts keep only those types. Returns null when the
 * worktree follows nothing of those types, so the card can be dropped.
 *
 * The card's unread badge and edge are left as they are — they are
 * worktree-wide aggregates from the backend, with no per-type breakdown to
 * narrow them by.
 */
export function filterWorktreeBySources(w: WorktreeSummary, sources: string[]): WorktreeSummary | null {
  if (sources.length === 0) return w
  const focus = w.focus_resources.filter((r) => matchesSources(r.type, sources))
  const relatedByType = Object.fromEntries(
    Object.entries(w.related_by_type ?? {}).filter(([t, n]) => n > 0 && matchesSources(t, sources)),
  )
  if (focus.length === 0 && Object.keys(relatedByType).length === 0) return null
  return { ...w, focus_resources: focus, related_by_type: relatedByType }
}
