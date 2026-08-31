const TYPE_LABELS: Record<string, [string, string]> = {
  pr: ["PR", "PRs"],
  jira: ["Jira issue", "Jira issues"],
  slack: ["Slack thread", "Slack threads"],
}

const TYPE_ORDER = ["pr", "jira", "slack"]

function labelFor(type: string, count: number): string {
  const known = TYPE_LABELS[type]
  if (known) return count === 1 ? known[0] : known[1]
  return count === 1 ? type : `${type}s`
}

function orderedTypes(byType: Record<string, number>): string[] {
  const types = Object.keys(byType).filter((t) => byType[t] > 0)
  const known = TYPE_ORDER.filter((t) => types.includes(t))
  const unknown = types.filter((t) => !TYPE_ORDER.includes(t)).sort()
  return [...known, ...unknown]
}

export function resourceSummary(primaryByType: Record<string, number>, relatedCount: number): string {
  const types = orderedTypes(primaryByType)
  const relatedPart = relatedCount > 0 ? `${relatedCount} related resource${relatedCount === 1 ? "" : "s"}` : ""

  if (types.length === 0) {
    return relatedPart
  }

  const primaryPart = types.map((t) => `${primaryByType[t]} ${labelFor(t, primaryByType[t])}`).join(", ")
  return relatedPart ? `${primaryPart} · ${relatedPart}` : primaryPart
}

/**
 * The worktree card's related-resources line, named by type:
 * "2 related Slack threads, 1 related Jira issue".
 *
 * Related resources are never listed individually on the card — they are the
 * ones not marked as the point of the worktree — so this is the only place
 * their shape is visible. Naming the types beats a bare total: "2 related
 * Slack threads" tells you where to look, "2 related resources" does not.
 *
 * Returns "" when there are none, so the caller can skip the line entirely.
 * Tolerates a missing map: an older cached response has no related_by_type.
 */
export function relatedSummary(relatedByType: Record<string, number> | undefined): string {
  const byType = relatedByType ?? {}
  const types = orderedTypes(byType)
  if (types.length === 0) return ""
  return types.map((t) => `${byType[t]} related ${labelFor(t, byType[t])}`).join(", ")
}
