import type { ResourceDTO, Task, TimelineEvent, WorktreeSummary } from "../../api/types"
import { matchResource, matchTask, matchWorktree, rankResource, rankTask, rankText, resourceLabel } from "../../lib/search"
import { shortResourceRef } from "../../lib/resourceRef"
import type { Suggestion } from "./SearchBar"

/** What the Activity row says under its title, by the field that matched. */
function eventDetail(e: TimelineEvent): string | undefined {
  switch (e.match?.field) {
    case "body":
      return e.match.snippet
    case "resource":
      // A task event's pseudo-resource has no DTO; resource_title is its task's title.
      return e.resource?.custom_name || e.resource?.title || e.resource_title
        || shortResourceRef(e.resource_type, e.resource_id)
    default:
      return e.author
  }
}

/** The task a task event belongs to, or null for any other event. */
function taskIdOf(e: TimelineEvent): number | null {
  if (e.resource_type !== "task") return null
  const id = Number(e.resource_id)
  return Number.isInteger(id) && id > 0 ? id : null
}

export const SUGGESTION_LIMITS = { worktrees: 3, resources: 5, tasks: 3, events: 3 } as const

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
  /** The tasks the page's task panel lists. */
  tasks?: Task[]
  events: TimelineEvent[]
  go: {
    worktree: (path: string) => void
    resource: (r: ResourceDTO, path?: string) => void
    event: (e: TimelineEvent) => void
    /**
     * Opens a task: a task event's row picks this, as its row in the feeds
     * does (EventRow's onOpenTask), never go.event — its pseudo-resource
     * ("task", "<id>") is nothing to select.
     */
    task?: (id: number) => void
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
  // Open tasks before done ones, then as resources rank.
  const ts = byRank(
    (input.tasks ?? []).map((t) => ({ t, match: matchTask(t, terms) })).filter(({ match }) => match),
    ({ t }) => rankTask(t, terms) + (t.state === "done" ? 10 : 0),
  ).slice(0, SUGGESTION_LIMITS.tasks)
  const evs = input.events.slice(0, SUGGESTION_LIMITS.events)

  return [
    ...wts.map(({ w }): Suggestion => ({
      key: `wt:${w.path}`, group: "Worktrees", label: w.branch, detail: w.repo, item: { kind: "worktree", w },
      onPick: () => go.worktree(w.path),
    })),
    ...rs.map(({ r, worktreePath }): Suggestion => ({
      key: `res:${r.type}:${r.id}`, group: "Resources", label: resourceLabel(r), detail: shortResourceRef(r.type, r.id),
      item: { kind: "resource", r },
      onPick: () => go.resource(r, worktreePath),
    })),
    ...ts.map(({ t, match }): Suggestion => ({
      key: `task:${t.id}`, group: "Tasks", label: t.title, detail: t.ref, item: { kind: "task", t, match },
      onPick: () => go.task?.(t.id),
    })),
    ...evs.map((e): Suggestion => ({
      key: `ev:${e.id}`, group: "Activity", label: e.title, detail: eventDetail(e), item: { kind: "event", e },
      onPick: () => {
        const taskId = taskIdOf(e)
        if (taskId !== null && go.task) go.task(taskId)
        else go.event(e)
      },
    })),
  ]
}
