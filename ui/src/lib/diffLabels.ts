import type { Commit, DiffBase, DiffRange, WorktreeGit } from "../api/types"

/** The Code tab's badge: "↑8 ↓12 · 4" (ahead, behind, changed files), or null when there is nothing to show. */
export function formatBadge(git: WorktreeGit, base: DiffBase): string | null {
  const ab = base === "merge-base" ? git.vs_merge_base : git.vs_tracking
  const ahead = ab?.ahead ?? 0
  const behind = ab?.behind ?? 0
  const files = git.working?.files ?? 0
  if (ahead === 0 && behind === 0 && files === 0) return null
  return `↑${ahead} ↓${behind}${files > 0 ? ` · ${files}` : ""}`
}

/**
 * The commit picker's summary of a range. `commits` is newest first; the
 * picker's entries are "uncommitted" followed by those commits, and a range
 * runs from its oldest entry to its newest.
 */
export function rangeLabel(commits: Commit[], range: DiffRange): string {
  if (range === "all") return "All changes"
  const entries = ["uncommitted", ...commits.map((c) => c.sha)]
  const newest = entries.indexOf(range.to)
  const oldest = entries.indexOf(range.from)
  // A selection naming something no longer listed is stale; the hook resets it.
  if (newest < 0 || oldest < 0 || newest > oldest) return "All changes"

  const uncommitted = newest === 0
  // Commits in the run: entries 1..oldest when it starts at uncommitted.
  const picked = uncommitted ? oldest : oldest - newest + 1
  if (picked === 0) return "Uncommitted changes"
  if (picked === commits.length) return uncommitted ? "All changes" : "All commits"
  const base = picked === 1 ? "1 commit" : `${picked} of ${commits.length} commits`
  return uncommitted ? `${base} + uncommitted` : base
}
