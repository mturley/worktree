/**
 * Whether an event's body is a Slack message (mrkdwn): a reply, or the
 * thread's root on watch_started. A Slack watcher_error's body is an error
 * string, and watch_started is shared with GitHub and Jira, so both the
 * source and the type decide.
 */
export function isSlackMessageEvent(source: string, type: string): boolean {
  return source === "slack" && (type === "slack_reply" || type === "watch_started")
}
