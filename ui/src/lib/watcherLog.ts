import type { PollLogEntry, WatcherLogScope } from "../api/types"

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
