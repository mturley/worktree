import type { PollLogEntry, WatchedResourceStatus, WatcherLogScope } from "../api/types"

/** Query params for a watcher log scope. A resource scope wins over a worktree. */
export function scopeParams(scope: WatcherLogScope): URLSearchParams {
  const p = new URLSearchParams()
  if (scope.resource) p.set("resource", `${scope.resource.type}:${scope.resource.id}`)
  else if (scope.worktree) p.set("worktree", scope.worktree)
  return p
}

function dedupeDesc(rows: PollLogEntry[]): PollLogEntry[] {
  const seen = new Set<number>()
  return rows
    .filter((r) => {
      if (seen.has(r.id)) return false
      seen.add(r.id)
      return true
    })
    .sort((a, b) => b.id - a.id)
}

/** Merge rows fetched with after_id into the newest-first list. */
export function mergeNewer(current: PollLogEntry[], incoming: PollLogEntry[]): PollLogEntry[] {
  return dedupeDesc([...incoming, ...current])
}

/** Merge rows fetched with before_id onto the end of the list. */
export function appendOlder(current: PollLogEntry[], older: PollLogEntry[]): PollLogEntry[] {
  return dedupeDesc([...current, ...older])
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** "POST api.github.com/graphql → 504 · 12.3 s · 1.2 KB", or null for non-http rows. */
export function httpSummary(e: PollLogEntry): string | null {
  if (e.kind !== "http") return null
  const parts = [`${e.method ?? ""} ${e.endpoint ?? ""} → ${e.http_status ?? "failed"}`]
  if (e.duration_ms) parts.push(formatDuration(e.duration_ms))
  if (e.bytes) parts.push(formatBytes(e.bytes))
  return parts.join(" · ")
}

/** Display label for a watched resource's type. */
export const SOURCE_LABEL: Record<string, string> = { pr: "GitHub", jira: "Jira", slack: "Slack" }

export type ResourceSortColumn = "source" | "updated" | "status"
export type ResourceSort = { column: ResourceSortColumn; dir: "asc" | "desc" } | null

/** A header click: off → asc → desc → off on the same column; another column starts at asc. */
export function nextSort(current: ResourceSort, column: ResourceSortColumn): ResourceSort {
  if (current?.column !== column) return { column, dir: "asc" }
  return current.dir === "asc" ? { column, dir: "desc" } : null
}

// Ascending status runs most-urgent first, the same severity order the server uses.
const STATUS_RANK: Record<WatchedResourceStatus["status"], number> = { error: 0, ok: 1, never: 2 }

function compareBy(column: ResourceSortColumn, a: WatchedResourceStatus, b: WatchedResourceStatus): number {
  switch (column) {
    case "source":
      return (SOURCE_LABEL[a.type] ?? a.type).localeCompare(SOURCE_LABEL[b.type] ?? b.type)
    case "updated":
      // "Never" sorts as older than any timestamp; RFC3339 UTC strings compare lexically.
      return (a.last_success ?? "").localeCompare(b.last_success ?? "")
    case "status":
      return STATUS_RANK[a.status] - STATUS_RANK[b.status]
  }
}

/**
 * Sorts a copy of the rows by one column, ties by name. A null sort keeps the
 * server's order (failing resources first, then by name).
 */
export function sortResources(rows: WatchedResourceStatus[], sort: ResourceSort): WatchedResourceStatus[] {
  if (!sort) return rows
  const sign = sort.dir === "asc" ? 1 : -1
  return [...rows].sort((a, b) => sign * (compareBy(sort.column, a, b) || a.name.localeCompare(b.name)))
}
