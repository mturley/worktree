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

function orderedTypes(primaryByType: Record<string, number>): string[] {
  const types = Object.keys(primaryByType).filter((t) => primaryByType[t] > 0)
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
