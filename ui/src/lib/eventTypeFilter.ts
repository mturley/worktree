/**
 * The Activity feed's per-source subfilters: once a source is picked, these
 * narrow it to one or more kinds of event ("Comments", "CI", …).
 *
 * Each category is a set of watcher event types, sent to the server as
 * `event_types` — filtering is server-side for the same reason the source
 * filter's is (see SourceFilter). A value ending in `*` is a prefix: CI has
 * many variants and the library keeps adding more, so "CI" names the family
 * rather than a list that would go stale.
 */
export interface EventCategory {
  key: string
  label: string
  types: string[]
}

export const EVENT_CATEGORIES: Record<string, EventCategory[]> = {
  pr: [
    { key: "comments", label: "Comments", types: ["pr_comment", "pr_review_comment"] },
    { key: "reviews", label: "Reviews", types: ["pr_review_requested", "pr_approved"] },
    { key: "commits", label: "Commits", types: ["pr_new_commits"] },
    { key: "ci", label: "CI", types: ["ci_*"] },
    { key: "state", label: "Merged / closed", types: ["pr_merged", "pr_closed", "pr_reopened"] },
  ],
  jira: [
    { key: "comments", label: "Comments", types: ["jira_comment"] },
    { key: "status", label: "Status", types: ["jira_status_change"] },
    { key: "assigned", label: "Assignee", types: ["jira_assigned"] },
    { key: "edits", label: "Edits", types: ["jira_description_changed", "jira_labels_changed"] },
  ],
  // Slack threads only produce replies today, so a bar would be one button
  // that changes nothing. Add categories here when the library grows more.
  slack: [],
  // "task" is the server's exact category value (not a prefix): it selects
  // every task_*/subtask_* event. While it is the only category under Tasks,
  // categoriesFor draws no bar for it — under that source every event is
  // already task activity — but it is the value any finer task category, or
  // a cross-source selection, would send.
  task: [{ key: "task", label: "Task activity", types: ["task"] }],
}

/**
 * The categories offered for a source selection, or none. Subfilters only
 * make sense under exactly one source — "Comments" across all three would be
 * a different feature — and a source with a single kind of event has nothing
 * to narrow.
 */
export function categoriesFor(sources: string[]): EventCategory[] {
  if (sources.length !== 1) return []
  const cats = EVENT_CATEGORIES[sources[0]] ?? []
  return cats.length > 1 ? cats : []
}

/**
 * The `event_types` to send for the selected category keys. Keys that do not
 * belong to the current source are dropped, so a stale selection can never
 * filter a feed down to nothing.
 */
export function eventTypesFor(sources: string[], keys: string[]): string[] {
  return categoriesFor(sources)
    .filter((c) => keys.includes(c.key))
    .flatMap((c) => c.types)
}
