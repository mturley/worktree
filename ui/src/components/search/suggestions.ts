import type { ResourceDTO, TimelineEvent, WorktreeSummary } from "../../api/types"
import { matchResource, matchWorktree, rankResource, rankText, resourceLabel } from "../../lib/search"
import { shortResourceRef } from "../../lib/resourceRef"
import type { Suggestion } from "./SearchBar"

/** What the Activity row says under its title, by the field that matched. */
function eventDetail(e: TimelineEvent): string | undefined {
  switch (e.match?.field) {
    case "body":
      return e.match.snippet
    case "resource":
      return e.resource?.custom_name || e.resource?.title || shortResourceRef(e.resource_type, e.resource_id)
    default:
      return e.author
  }
}

export const SUGGESTION_LIMITS = { worktrees: 3, resources: 5, events: 3 } as const

/**
 * The dropdown's rows: the top few matches per kind, ranked (exact key,
 * then title prefix, then title contains, then other fields; ties keep the
 * input order). Events arrive already matched and newest first — they are
 * the head of the page's own search-filtered feed.
 */
export function buildSuggestions(input: {
  terms: string[]
  worktrees?: { w: WorktreeSummary; workspaceTitles: string[]; resources: ResourceDTO[] }[]
  resources: { r: ResourceDTO; worktreePath?: string }[]
  events: TimelineEvent[]
  go: {
    worktree: (path: string) => void
    resource: (r: ResourceDTO, path?: string) => void
    event: (e: TimelineEvent) => void
  }
}): Suggestion[] {
  const { terms, go } = input
  if (terms.length === 0) return []
  const byRank = <T,>(xs: T[], rank: (x: T) => number) =>
    xs.map((x, i) => ({ x, i, k: rank(x) })).sort((a, b) => a.k - b.k || a.i - b.i).map((e) => e.x)

  const wts = byRank(
    (input.worktrees ?? []).filter(({ w, workspaceTitles, resources }) => matchWorktree(w, workspaceTitles, resources, terms)),
    ({ w }) => rankText(w.branch, terms),
  ).slice(0, SUGGESTION_LIMITS.worktrees)
  const rs = byRank(input.resources.filter(({ r }) => matchResource(r, terms)), ({ r }) => rankResource(r, terms))
    .slice(0, SUGGESTION_LIMITS.resources)
  const evs = input.events.slice(0, SUGGESTION_LIMITS.events)

  return [
    ...wts.map(({ w }): Suggestion => ({
      key: `wt:${w.path}`, group: "Worktrees", label: w.branch, detail: w.repo, onPick: () => go.worktree(w.path),
    })),
    ...rs.map(({ r, worktreePath }): Suggestion => ({
      key: `res:${r.type}:${r.id}`, group: "Resources", label: resourceLabel(r), detail: shortResourceRef(r.type, r.id),
      onPick: () => go.resource(r, worktreePath),
    })),
    ...evs.map((e): Suggestion => ({
      key: `ev:${e.id}`, group: "Activity", label: e.title, detail: eventDetail(e),
      onPick: () => go.event(e),
    })),
  ]
}
