/**
 * A short, human reference for a resource: "#42" for a PR, the key for a Jira
 * issue. Slack ids are channel:ts pairs with nothing readable in them, so they
 * get no reference and lean on the title instead.
 *
 * Shared so the timeline's event chips and the worktree cards' resource lines
 * abbreviate the same id the same way.
 */
export function shortResourceRef(type: string, id: string): string {
  if (type === "pr") {
    const hash = id.lastIndexOf("#")
    return hash >= 0 ? id.slice(hash) : id
  }
  if (type === "jira") return id
  return ""
}
