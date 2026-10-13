/**
 * Badge colours for a resource's status, shared by the resource cards and
 * the Linked Resources tab so a status reads the same everywhere. Shown as
 * `variant="light"` badges.
 */

/** A PR's state: open green, merged violet, closed red; a draft is gray. */
export function prStateColor(state?: string, isDraft?: boolean): string {
  switch ((state || "").toUpperCase()) {
    case "OPEN": return isDraft ? "gray" : "green"
    case "MERGED": return "violet"
    case "CLOSED": return "red"
    default: return "gray"
  }
}

/**
 * A Jira status, by name, as a ramp toward done: not started gray, in
 * progress blue, review violet, testing teal, finished green, blocked orange
 * (not red or yellow, which would read as errors or warnings). Matched by
 * name rather than Jira's status category because cached cards only have the
 * name; unrecognised names fall back to gray.
 */
export function jiraStatusColor(status?: string): string {
  const s = (status || "").toLowerCase()
  if (/block/.test(s)) return "orange"
  if (/closed|resolved|done/.test(s)) return "green"
  if (/test|\bqa\b/.test(s)) return "teal"
  if (/review/.test(s)) return "violet"
  if (/progress/.test(s)) return "blue"
  return "gray"
}
