import { parseThreadUrl } from "./parseThreadUrl"

/**
 * The slack resource id a thread URL corresponds to, or null if the URL is
 * not a Slack thread link.
 *
 * Mirrors the Go side's `slackurl.ResourceID` (channel + ":" + threadTS), so
 * a URL found in a message unfurl can be matched against the ids stored in
 * the worktree's resource list.
 */
export function slackResourceIdForUrl(url: string): string | null {
  const parsed = parseThreadUrl(url)
  if (!parsed) return null
  return `${parsed.channel}:${parsed.threadTs}`
}
