// Renders Slack's INLINE mrkdwn syntax (the small, undocumented markup Slack
// uses in plain-text fields that don't have a `blocks` representation, e.g.
// attachment `text`/`pretext`/fallback message `text`). This is deliberately
// narrower than RichText: it only handles inline tokens (mentions, links,
// emoji, and single-level *bold*/_italic_/~strike~/`code` styling). Block
// constructs like `>` quotes and ``` code fences are NOT handled here — those
// come through Slack's `blocks` payload and are rendered by RichText.tsx.
import { Fragment } from 'react'
import { safeHref, unescapeSlackText } from '../api/slackApi'
import type { User } from '../api/slackApi'
import { renderEmojiNode } from './renderEmoji'

interface MrkdwnProps {
  text: string
  users: Record<string, User>
  emoji: Record<string, string>
}

/** Renders a run that has NO emphasis or code delimiters left: resolves
 * angle-bracket tokens (mentions/links) and `:emoji:` tokens, entity-
 * unescaping the remaining literal text. This is the shared "inline leaf"
 * pipeline, used both at the top level (between emphasis segments) and INSIDE
 * an emphasis segment, so `*bold*`/`_italic_`/`~strike~` can wrap a mention,
 * link, or emoji and still style it. */
function renderInline(
  text: string,
  users: Record<string, User>,
  emoji: Record<string, string>,
  keyPrefix: string,
): React.ReactNode {
  // Angle tokens first (on the still-escaped text so an escaped `&lt;@U1&gt;`
  // can't masquerade as a mention), then emoji within the remaining runs.
  const anglePattern = /<([^<>]+)>/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let i = 0
  while ((match = anglePattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <Fragment key={`${keyPrefix}-t-${i}`}>{renderRunEmoji(text.slice(lastIndex, match.index), emoji, `${keyPrefix}-t-${i}`)}</Fragment>,
      )
      i++
    }
    parts.push(renderAngleToken(match[1], `${keyPrefix}-a-${i}`, users))
    i++
    lastIndex = anglePattern.lastIndex
  }
  if (lastIndex < text.length) {
    parts.push(
      <Fragment key={`${keyPrefix}-t-${i}`}>{renderRunEmoji(text.slice(lastIndex), emoji, `${keyPrefix}-t-${i}`)}</Fragment>,
    )
  }
  return <>{parts}</>
}

/** Renders a run with no angle tokens: resolves `:emoji_name:` tokens and
 * entity-unescapes the remaining literal text. */
function renderRunEmoji(
  text: string,
  emoji: Record<string, string>,
  keyPrefix: string,
): React.ReactNode {
  const pattern = /:([a-zA-Z0-9_+-]+):/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let i = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <Fragment key={`${keyPrefix}-t-${i}`}>{unescapeSlackText(text.slice(lastIndex, match.index))}</Fragment>,
      )
      i++
    }
    parts.push(renderEmojiNode(match[1], undefined, emoji, `${keyPrefix}-emoji-${i}`))
    i++
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < text.length) {
    parts.push(<Fragment key={`${keyPrefix}-t-${i}`}>{unescapeSlackText(text.slice(lastIndex))}</Fragment>)
  }
  return <>{parts}</>
}

// Matches a `:emoji_name:` token as a single unit. Included alongside the
// emphasis delimiters below so that an emoji name containing underscores
// (e.g. ":white_check_mark:") is never mistaken for an `_italic_` span by
// the emphasis split — the leftmost-match rule means whichever pattern can
// start at a given position "wins", and colon tokens only ever compete for
// positions that start with `:`.
const EMOJI_TOKEN = /:[a-zA-Z0-9_+-]+:/

/** Renders a run with emphasis as the OUTER split: code spans and single-level
 * `*bold*`/`_italic_`/`~strike~` segments are pulled out first, and each
 * segment's inner content is recursed through `renderInline` so a mention,
 * link, or emoji INSIDE emphasis is still resolved (and still styled). Code
 * span contents stay fully literal. Only delimiters that actually close are
 * paired; an unpaired `*` is literal. */
function renderStyledText(
  text: string,
  keyPrefix: string,
  users: Record<string, User>,
  emoji: Record<string, string>,
): React.ReactNode {
  // Split on code spans first — their contents must stay literal.
  const codeSplit = text.split(/(`[^`]+`)/)
  return codeSplit.map((chunk, ci) => {
    const codeKey = `${keyPrefix}-c-${ci}`
    if (chunk.startsWith('`') && chunk.endsWith('`') && chunk.length >= 2) {
      return <code key={codeKey}>{unescapeSlackText(chunk.slice(1, -1))}</code>
    }
    // Then split on emphasis + standalone emoji tokens.
    const pattern = new RegExp(`(\\*[^*]+\\*|_[^_]+_|~[^~]+~|${EMOJI_TOKEN.source})`)
    const parts = chunk.split(pattern)
    return (
      <Fragment key={codeKey}>
        {parts.map((part, i) => {
          const key = `${codeKey}-e-${i}`
          if (part.length >= 2) {
            if (part.startsWith('*') && part.endsWith('*')) {
              return <strong key={key}>{renderInline(part.slice(1, -1), users, emoji, key)}</strong>
            }
            if (part.startsWith('_') && part.endsWith('_')) {
              return <em key={key}>{renderInline(part.slice(1, -1), users, emoji, key)}</em>
            }
            if (part.startsWith('~') && part.endsWith('~')) {
              return <del key={key}>{renderInline(part.slice(1, -1), users, emoji, key)}</del>
            }
            if (new RegExp(`^${EMOJI_TOKEN.source}$`).exec(part)) {
              return renderEmojiNode(part.slice(1, -1), undefined, emoji, key)
            }
          }
          // Non-emphasis run: resolve angle tokens + emoji via the shared leaf.
          return <Fragment key={key}>{renderInline(part, users, emoji, key)}</Fragment>
        })}
      </Fragment>
    )
  })
}

/** Renders the inner content of a single `<...>` angle-bracket token. */
function renderAngleToken(
  inner: string,
  key: string,
  users: Record<string, User>,
): React.ReactNode {
  if (inner.startsWith('@')) {
    const id = inner.slice(1)
    const user = users[id]
    const label = user ? `@${user.DisplayName || user.RealName}` : `@${id}`
    return <span key={key}>{label}</span>
  }
  if (inner.startsWith('!subteam^')) {
    const rest = inner.slice('!subteam^'.length)
    const pipeIdx = rest.indexOf('|')
    if (pipeIdx >= 0) {
      let label = rest.slice(pipeIdx + 1)
      if (!label.startsWith('@')) {
        label = `@${label}`
      }
      return <span key={key}>{label}</span>
    }
    return <span key={key}>@subteam</span>
  }
  if (inner === '!here') {
    return <span key={key}>@here</span>
  }
  if (inner === '!channel') {
    return <span key={key}>@channel</span>
  }
  if (inner === '!everyone') {
    return <span key={key}>@everyone</span>
  }
  // Link: <url> or <url|label>
  const pipeIdx = inner.indexOf('|')
  const rawUrl = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner
  const url = unescapeSlackText(rawUrl)
  const label = pipeIdx >= 0 ? unescapeSlackText(inner.slice(pipeIdx + 1)) : url
  const href = safeHref(url)
  if (href === undefined) {
    return <span key={key}>{label}</span>
  }
  return (
    <a key={key} href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  )
}

/**
 * Parses a Slack inline mrkdwn string into React nodes: user/subteam/
 * broadcast mentions, links, `:emoji:` tokens, and single-level bold,
 * italic, strike, and code styling.
 *
 * Pipeline: emphasis + code spans are the OUTER split (renderStyledText), and
 * each emphasis segment's inner content recurses through renderInline, which
 * resolves angle-bracket tokens (mentions/links) and `:emoji:`. So a mention,
 * link, or emoji INSIDE `*bold*`/`_italic_`/`~strike~` is both resolved and
 * styled (e.g. `*<url|label>*` → a bold anchor). Angle tokens are matched on
 * the still-escaped text so an escaped `&lt;@U1&gt;` is never mistaken for a
 * real mention; entity unescaping happens last, only on literal runs. Code
 * span contents stay fully literal.
 *
 * Known limitation: emphasis does not nest within emphasis (single level).
 */
export function Mrkdwn({ text, users, emoji }: MrkdwnProps) {
  if (!text) {
    return null
  }
  return <>{renderStyledText(text, 'md', users, emoji)}</>
}
