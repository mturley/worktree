import { Fragment } from 'react'
import { safeHref } from '../../api/slackApi'
import type { Block, Element, User } from '../../api/slackApi'
import { renderEmojiNode } from '../../lib/renderEmoji'
import { Mention } from './Mention'

interface RichTextProps {
  blocks: Block[] | null | undefined
  users: Record<string, User>
  emoji: Record<string, string>
}

/** Renders a single rich-text leaf Element to a React node. */
function renderElement(el: Element, key: number, users: Record<string, User>, emoji: Record<string, string>) {
  switch (el.Type) {
    case 'text': {
      let node: React.ReactNode = el.Text
      if (el.Style.Code) {
        node = <code>{node}</code>
      }
      if (el.Style.Italic) {
        node = <em>{node}</em>
      }
      if (el.Style.Bold) {
        node = <strong>{node}</strong>
      }
      if (el.Style.Strike) {
        node = <del>{node}</del>
      }
      return <Fragment key={key}>{node}</Fragment>
    }
    case 'user': {
      const user = users[el.UserID]
      const label = user ? `@${user.DisplayName || user.RealName}` : `@${el.UserID}`
      return <Mention key={key}>{label}</Mention>
    }
    case 'link': {
      const label = el.Text || el.URL
      const href = safeHref(el.URL)
      if (href === undefined) {
        return <span key={key}>{label}</span>
      }
      return (
        <a key={key} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>
      )
    }
    case 'emoji':
      return renderEmojiNode(el.Name, el.Unicode, emoji, key)
    case 'usergroup':
      // Slack's payload carries a usergroup_id, but the watcher library's
      // Element type only surfaces Name — so when Name is empty there is
      // nothing local to fall back to but the generic word. Fixing this is
      // the cross-repo half of Phase D: surface usergroup_id (and the group
      // directory) in github.com/mturley/watcher/slack, then resolve here.
      return <Mention key={key}>@{el.Name || 'usergroup'}</Mention>
    case 'broadcast':
      return <Mention key={key}>@{el.Name || 'here'}</Mention>
    default:
      return <Fragment key={key}>{el.Text}</Fragment>
  }
}

/**
 * Renders an array of leaf Elements inline. Shared by section paragraphs,
 * list items, quotes, and preformatted blocks so they all resolve mentions/
 * links/emoji/styles consistently.
 */
export function renderLeafElements(
  elements: Element[] | null | undefined,
  users: Record<string, User>,
  emoji: Record<string, string>,
) {
  if (!elements || elements.length === 0) {
    return null
  }
  return <>{elements.map((el, i) => renderElement(el, i, users, emoji))}</>
}

function renderBlock(block: Block, key: number, users: Record<string, User>, emoji: Record<string, string>) {
  switch (block.Type) {
    case 'list': {
      const items = block.Items ?? []
      const listStyle: React.CSSProperties = { margin: '2px 0', marginLeft: 20 + block.Indent * 20 }
      return block.Style === 'ordered' ? (
        <ol key={key} style={listStyle}>
          {items.map((item, i) => (
            <li key={i}>{renderLeafElements(item, users, emoji)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key} style={listStyle}>
          {items.map((item, i) => (
            <li key={i}>{renderLeafElements(item, users, emoji)}</li>
          ))}
        </ul>
      )
    }
    case 'quote':
      return (
        <blockquote
          key={key}
          style={{
            margin: '4px 0',
            paddingLeft: 10,
            borderLeft: '3px solid var(--mantine-color-dark-2)',
            color: 'var(--mantine-color-dimmed)',
          }}
        >
          {renderLeafElements(block.Elements, users, emoji)}
        </blockquote>
      )
    case 'preformatted':
      return (
        <pre
          key={key}
          style={{
            margin: '4px 0',
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {renderLeafElements(block.Elements, users, emoji)}
        </pre>
      )
    case 'section':
    default:
      return (
        <p key={key} style={{ margin: 0 }}>
          {renderLeafElements(block.Elements, users, emoji)}
        </p>
      )
  }
}

/** Renders a Message's rich-text Blocks (sections, lists, quotes, code). */
export function RichText({ blocks, users, emoji }: RichTextProps) {
  if (!blocks || blocks.length === 0) {
    return null
  }
  return <>{blocks.map((block, i) => renderBlock(block, i, users, emoji))}</>
}
