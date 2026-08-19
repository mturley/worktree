// Shared JSX for rendering a resolved emoji reference, used by both the
// inline mrkdwn renderer (mrkdwn.tsx) and the rich-text renderer
// (RichText.tsx) so `:name:` tokens render identically in both paths.
import { Fragment } from 'react'
import { emojiProxy } from '../api/slackApi'
import { resolveEmoji } from './emoji'

/** Resolves `name`/`unicode` against `emoji` and renders the result: a
 * unicode glyph, a custom-emoji `<img>`, or a `:name:` text fallback. */
export function renderEmojiNode(
  name: string,
  unicode: string | undefined,
  emoji: Record<string, string>,
  key: React.Key,
): React.ReactNode {
  const resolved = resolveEmoji(name, unicode, emoji)
  if (resolved.kind === 'unicode') {
    return <Fragment key={key}>{resolved.char}</Fragment>
  }
  if (resolved.kind === 'image') {
    return (
      <img
        key={key}
        src={emojiProxy(resolved.url)}
        alt={`:${name}:`}
        style={{ height: '1.35em', verticalAlign: 'middle' }}
      />
    )
  }
  return <Fragment key={key}>{resolved.text}</Fragment>
}
