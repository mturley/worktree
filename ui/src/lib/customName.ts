/**
 * Whether a resource type supports a user-supplied custom NAME.
 *
 * A PR or Jira issue arrives with a title from its source; a Slack thread has
 * none, and a link's fetched title is often a site's boilerplate — both are
 * worth renaming. Shared so the edit modal and the button that opens it
 * cannot disagree about what the modal offers.
 */
export function supportsCustomName(type: string): boolean {
  return type === "slack" || type === "link"
}
