/**
 * Whether an event's body is a Slack message (mrkdwn): a reply, the
 * thread's first message (slack_thread_root), or that root again on
 * watch_started. A Slack watcher_error's body is an error
 * string, and watch_started is shared with GitHub and Jira, so both the
 * source and the type decide.
 */
export function isSlackMessageEvent(source: string, type: string): boolean {
  return source === "slack" && (type === "slack_reply" || type === "slack_thread_root" || type === "watch_started")
}

/** A Slack message event's body without its leading "Author: ": the title
 * (and the modal's header) already names the author. */
export function slackMessageText(body: string, author: string | undefined): string {
  const prefix = author ? `${author}: ` : ""
  return prefix && body.startsWith(prefix) ? body.slice(prefix.length) : body
}
