import type { User, UserGroup } from "../api/slackApi"

/**
 * Rewrites Slack's mention tokens in a raw message string into the plain text
 * a reader expects: `<@U123>` becomes `@ana`, `<!subteam^S1|@platform>`
 * becomes `@platform`, `<!here>` becomes `@here`.
 *
 * This exists because the message BODY resolves mentions (via RichText /
 * mrkdwn) but plain-string consumers did not — most visibly the untitled
 * thread's fallback title, which showed raw `<@U123>` ids for the very same
 * text that renders as a name one line below.
 *
 * Unknown ids fall back to the bare id (`@U999`), never to a generic word:
 * an unresolved mention should still tell you *which* mention it was.
 *
 * Returns plain text, not nodes, because its callers render into contexts
 * that need a string (a title). Mention pill styling is therefore not applied
 * here — see components/slack/Mention.tsx for the rendered form.
 */
export function resolveMentionsToText(
  text: string | undefined,
  users: Record<string, User> | undefined,
  groups?: Record<string, UserGroup>,
): string {
  if (!text) return ""

  return text.replace(/<([^<>]+)>/g, (whole, inner: string) => {
    // User mention: <@U123>
    if (inner.startsWith("@")) {
      const id = inner.slice(1)
      const user = users?.[id]
      const name = user?.DisplayName || user?.RealName
      return name ? `@${name}` : `@${id}`
    }
    // Group mention: <!subteam^S1> or <!subteam^S1|@handle>
    if (inner.startsWith("!subteam^")) {
      const rest = inner.slice("!subteam^".length)
      const pipeIdx = rest.indexOf("|")
      if (pipeIdx >= 0) {
        const label = rest.slice(pipeIdx + 1)
        return label.startsWith("@") ? label : `@${label}`
      }
      // Prefer the group's handle (that is what Slack shows), then its name,
      // then the bare id — never a generic word, so an unresolved group is
      // still identifiable.
      const g = groups?.[rest]
      return `@${g?.Handle || g?.Name || rest}`
    }
    if (inner === "!here") return "@here"
    if (inner === "!channel") return "@channel"
    if (inner === "!everyone") return "@everyone"
    // Anything else (links, unknown tokens) is left exactly as it was.
    return whole
  })
}
