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

// A ``` fence (may span lines) or a one-line `code` span, as a capturing
// group: split() puts each code piece at an odd index.
export const MRKDWN_CODE = /(```[\s\S]*?```|`[^`\n]+`)/

/** A fence's contents, without the line breaks that hug its delimiters
 * (Slack doesn't show them). */
export function fenceBody(fence: string): string {
  return fence.slice(3, -3).replace(/^\n/, "").replace(/\n$/, "")
}

const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}_])"
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}_])"

/**
 * An emphasis span (`*bold*`, `_italic_`, `~strike~`) as Slack styles one:
 * its delimiters sit at word boundaries (so max_tokens, a*b*c and @mike_t
 * stay literal) and it never crosses a line. A regex source for the /u flag.
 */
export function mrkdwnEmphasisSpan(d: "*" | "_" | "~"): string {
  const e = d === "*" ? "\\*" : d // in /u mode only * may (and must) be escaped
  return `${NOT_WORD_BEFORE}${e}[^${d}\\n]+${e}${NOT_WORD_AFTER}`
}

const EMPHASIS_ANY = new RegExp(
  `${mrkdwnEmphasisSpan("*")}|${mrkdwnEmphasisSpan("_")}|${mrkdwnEmphasisSpan("~")}`,
  "gu",
)

/**
 * A whole Slack message as plain text, for a one- or two-line preview:
 * mrkdwnToPlain's tokens and entities, plus emphasis marks and code
 * backticks dropped (code contents stay literal). Matches what `<Mrkdwn>`
 * renders, minus the styling.
 *
 * `revealTerms`: a link whose URL contains any of them (case-insensitive)
 * is written as its URL instead of its label, so a search that matched the
 * URL can show the hit.
 */
export function slackMessageToPlain(text: string, revealTerms: string[] = []): string {
  const terms = revealTerms.map((t) => t.toLowerCase()).filter((t) => t !== "")
  return text
    .split(MRKDWN_CODE)
    .map((chunk, i) => {
      if (i % 2 === 1) {
        const code = chunk.startsWith("```") ? fenceBody(chunk) : chunk.slice(1, -1)
        return code.replace(/&(lt|gt|amp);/g, (m) => ENTITIES[m])
      }
      const revealed = terms.length === 0 ? chunk : chunk.replace(LABELLED_LINK, (m, url: string) =>
        terms.some((t) => url.toLowerCase().includes(t)) ? `<${url}>` : m)
      return mrkdwnToPlain(revealed.replace(EMPHASIS_ANY, (m) => m.slice(1, -1)))
    })
    .join("")
}

// A labelled link token, <url|label>: the url is anything that isn't a
// mention, channel or broadcast (those start with @, # or !).
const LABELLED_LINK = /<([^@#!<>|][^<>|]*)\|[^<>]*>/g
