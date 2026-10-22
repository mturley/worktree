import type { User } from "../api/slackApi"

/** Slack mrkdwn's angle-bracket tokens: mentions, channels, commands, links. */
const TOKEN = /<([^<>]+)>/g

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&" }

/**
 * A line of Slack mrkdwn as plain text, for a task title: `<@U…|name>` →
 * `@name` (the user's display name when `users` knows them, else `@user`),
 * `<#C…|name>` → `#name`, `<!here>` → `@here`, `<url|label>` → `label`,
 * `<url>` → `url`, then `&lt;` `&gt;` `&amp;` unescaped. Formatting marks are
 * left alone. Rendering a message goes through `<Mrkdwn>`; this is only for
 * text that must be a plain string. The server's twin is slackPlain in
 * internal/webui/slackplain.go.
 */
export function mrkdwnToPlain(text: string, users?: Record<string, Pick<User, "DisplayName" | "RealName">>): string {
  const plain = text.replace(TOKEN, (_m, inner: string) => {
    const bar = inner.indexOf("|")
    const target = bar < 0 ? inner : inner.slice(0, bar)
    const label = bar < 0 ? "" : inner.slice(bar + 1)
    if (target.startsWith("@")) {
      if (label) return `@${label.replace(/^@/, "")}`
      const u = users?.[target.slice(1)]
      const name = u?.DisplayName || u?.RealName
      return name ? `@${name}` : "@user"
    }
    if (target.startsWith("#")) return label ? `#${label.replace(/^#/, "")}` : "#channel"
    if (target.startsWith("!")) return label || `@${target.slice(1).split("^")[0]}`
    return label || target
  })
  // One pass, so "&amp;lt;" becomes "&lt;", not "<".
  return plain.replace(/&(lt|gt|amp);/g, (m) => ENTITIES[m])
}
