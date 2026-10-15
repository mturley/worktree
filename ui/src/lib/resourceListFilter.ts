import type { AllResourceDTO } from "../api/types"
import { jiraStatusColor } from "./statusColors"
import { hasUnread } from "./unread"

/**
 * Sorting and filtering for the home page's Resources tab. Pure, so the
 * rules live here and the panel only renders them.
 */

export type ResourceSortMode = "updated" | "created" | "status" | "unread" | "name"
export type SortDir = "asc" | "desc"

export const RESOURCE_SORT_MODES: ResourceSortMode[] = ["updated", "created", "status", "unread", "name"]

export function isResourceSortMode(v: string): v is ResourceSortMode {
  return (RESOURCE_SORT_MODES as string[]).includes(v)
}

/** Modes with a direction toggle. Status and unread are fixed orders. */
export function hasResourceSortDirection(m: ResourceSortMode): boolean {
  return m === "updated" || m === "created" || m === "name"
}

/** The PR quick filters beyond state. */
export const PR_CONDITIONS = [
  { value: "ci_failure", label: "CI failing" },
  { value: "ci_pending", label: "CI pending" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "review_required", label: "Needs review" },
  { value: "approved", label: "Approved" },
  { value: "new_commits", label: "New commits" },
] as const

export const PR_STATES = [
  { value: "OPEN", label: "Open" },
  { value: "MERGED", label: "Merged" },
  { value: "CLOSED", label: "Closed" },
] as const

/**
 * The filters. `type` null is every type; the per-type subfilters apply only
 * while their type is selected. Within one group the values are alternatives
 * (Open OR Merged); separate groups narrow each other (Open AND CI failing
 * AND mine). An empty group does not narrow.
 */
export interface ResourceFilter {
  type: string | null
  prStates: string[]
  prConditions: string[]
  jiraStatuses: string[]
  slackChannels: string[]
  mine: boolean
}

export const EMPTY_FILTER: ResourceFilter = {
  type: null, prStates: [], prConditions: [], jiraStatuses: [], slackChannels: [], mine: false,
}

function prCondition(r: AllResourceDTO, c: string): boolean {
  switch (c) {
    case "ci_failure": return (r.ci_status ?? "").toLowerCase() === "failure"
    case "ci_pending": return (r.ci_status ?? "").toLowerCase() === "pending"
    case "changes_requested": return (r.review_decision ?? "").toUpperCase() === "CHANGES_REQUESTED"
    case "review_required": return (r.review_decision ?? "").toUpperCase() === "REVIEW_REQUIRED"
    case "approved": return (r.review_decision ?? "").toUpperCase() === "APPROVED"
    case "new_commits": return Boolean(r.new_commits_since_review)
    default: return false
  }
}

function anyOf<T>(selected: T[], test: (v: T) => boolean): boolean {
  return selected.length === 0 || selected.some(test)
}

export function matchesFilter(r: AllResourceDTO, f: ResourceFilter, unreadOnly: boolean): boolean {
  if (unreadOnly && !hasUnread(r)) return false
  if (f.type === null) return true
  if (r.type !== f.type) return false
  switch (r.type) {
    case "pr":
      return anyOf(f.prStates, (s) => (r.state ?? "").toUpperCase() === s)
        && anyOf(f.prConditions, (c) => prCondition(r, c))
        && (!f.mine || Boolean(r.mine))
    case "jira":
      return anyOf(f.jiraStatuses, (s) => r.status === s) && (!f.mine || Boolean(r.mine))
    case "slack":
      return anyOf(f.slackChannels, (c) => r.channel_name === c)
    default:
      return true
  }
}

/** The distinct values present, for the subfilters built from the data. */
export function distinctValues(rs: AllResourceDTO[], type: string, pick: (r: AllResourceDTO) => string | undefined): string[] {
  const set = new Set<string>()
  for (const r of rs) {
    if (r.type !== type) continue
    const v = pick(r)
    if (v) set.add(v)
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}

/**
 * A timestamp in ms, or null. RFC3339 for PRs and Jira; a Slack ts
 * ("1699000000.000100", seconds) for threads.
 */
export function timestampMs(ts?: string): number | null {
  if (!ts) return null
  if (/^\d+(\.\d+)?$/.test(ts)) return parseFloat(ts) * 1000
  const n = Date.parse(ts)
  return Number.isNaN(n) ? null : n
}

export function updatedMs(r: AllResourceDTO): number | null {
  return timestampMs(r.type === "slack" ? r.updated_ts : r.updated_at)
}

export function createdMs(r: AllResourceDTO): number | null {
  return timestampMs(r.type === "slack" ? r.created_ts : r.created_at)
}

export function displayName(r: AllResourceDTO): string {
  return r.custom_name || r.title || r.id
}

/**
 * Where a resource stands, as one ramp across types: things needing
 * attention first, finished things last. Blocked issues lead; open PRs sit
 * with work in progress; merged PRs and done issues together; closed PRs
 * after them; threads and links, which have no status, at the end.
 */
export function statusRank(r: AllResourceDTO): number {
  if (r.type === "pr") {
    switch ((r.state ?? "").toUpperCase()) {
      case "OPEN": return 1
      case "MERGED": return 5
      case "CLOSED": return 6
      default: return 7
    }
  }
  if (r.type === "jira") {
    if (!r.status) return 7
    switch (jiraStatusColor(r.status)) {
      case "orange": return 0
      case "blue": return 1
      case "violet": return 2
      case "teal": return 3
      case "green": return 5
      default: return 4
    }
  }
  return 7
}

/** Missing timestamps always sort last, whichever the direction. */
function byTime(a: number | null, b: number | null, dir: SortDir): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return dir === "asc" ? a - b : b - a
}

export function sortResources(rs: AllResourceDTO[], mode: ResourceSortMode, dir: SortDir): AllResourceDTO[] {
  const recent = (a: AllResourceDTO, b: AllResourceDTO) => byTime(updatedMs(a), updatedMs(b), "desc")
  const cmp = (a: AllResourceDTO, b: AllResourceDTO): number => {
    switch (mode) {
      case "updated": return byTime(updatedMs(a), updatedMs(b), dir)
      case "created": return byTime(createdMs(a), createdMs(b), dir) || recent(a, b)
      case "status": return statusRank(a) - statusRank(b) || recent(a, b)
      case "unread": return Number(hasUnread(b)) - Number(hasUnread(a)) || recent(a, b)
      case "name": {
        const c = displayName(a).localeCompare(displayName(b), undefined, { sensitivity: "base", numeric: true })
        return dir === "asc" ? c : -c
      }
    }
  }
  return [...rs].sort(cmp)
}
