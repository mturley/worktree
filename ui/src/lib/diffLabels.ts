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
 * The Code tab badge's color, by what is at risk of being lost: yellow for
 * uncommitted changes (the stronger warning, so it wins), else orange for
 * commits not pushed (ahead of the tracking branch, or with no tracking
 * branch, any commits past the merge base), else gray. Independent of the
 * chosen base: unpushed is unpushed whatever the badge counts against.
 */
export function badgeColor(git: WorktreeGit): "yellow" | "orange" | "gray" {
  if ((git.working?.files ?? 0) > 0) return "yellow"
  const unpushed = git.tracking ? (git.vs_tracking?.ahead ?? 0) : (git.vs_merge_base?.ahead ?? 0)
  return unpushed > 0 ? "orange" : "gray"
}

/**
 * Why there is nothing to compare against for `base`, or undefined when there
 * is: the merge base needs main's upstream, the tracking branch a push.
 */
export function diffUnavailable(git: WorktreeGit, base: DiffBase): string | undefined {
  if (base === "merge-base") {
    return !git.main_upstream || !git.merge_base ? "No merge base to compare with: main has no upstream." : undefined
  }
  return !git.tracking ? "No tracking branch to compare with: this branch isn't pushed." : undefined
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
