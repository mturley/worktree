export type Tab = {
  id: string
  channel: string
  threadTs: string
  name: string
  description: string
}

/**
 * The placeholder name assigned to a thread tab when the user hasn't provided
 * a custom title. Exported so UI that distinguishes "user-set title" from "no
 * title yet" (e.g. the Slack tab rail) can compare against it instead of
 * treating any non-empty `tab.name` as a custom title — which would otherwise
 * leak the raw channel/thread-ts into the UI.
 */
export function defaultTabName(channel: string, threadTs: string): string {
  return `${channel} @ ${threadTs}`
}
