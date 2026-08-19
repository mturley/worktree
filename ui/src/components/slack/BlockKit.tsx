import { useState } from 'react'
import { Group, Stack, Text } from '@mantine/core'
import type { BlockKit as BlockKitType, BlockElement, User } from '../../api/slackApi'
import { Mrkdwn } from '../../lib/mrkdwn'
import { RichText } from './RichText'

interface BlockKitProps {
  blocks: BlockKitType[] | null
  users: Record<string, User>
  emoji: Record<string, string>
}

/** True iff a single block would actually render visible content. A block
 * whose content is empty (a section/header with blank text and no image
 * accessory, an empty context, an empty rich_text) contributes nothing, and a
 * lone divider only separates real content — so none of these count on their
 * own. Keeps the attachment card's empty-content guard from showing an
 * empty-ish bordered card. */
function isContentBearing(b: BlockKitType): boolean {
  switch (b.Type) {
    case 'section':
      return !!b.Text?.Text || (b.Accessory?.Type === 'image' && !!b.Accessory.ImageURL)
    case 'header':
      return !!b.Text?.Text
    case 'context':
      return !!b.Elements && b.Elements.length > 0
    case 'image':
      return !!b.ImageURL
    case 'rich_text':
      return !!b.RichText && b.RichText.length > 0
    case 'divider': // only meaningful between other content
    case 'unsupported':
    default:
      return false
  }
}

/** True iff at least one block would render visible content. Used by the
 * attachment card's empty-content guard so an attachment whose blocks are all
 * unsupported/empty (or just a divider) stays hidden rather than showing an
 * empty bordered card. */
export function hasRenderableBlocks(blocks: BlockKitType[] | null): boolean {
  return !!blocks && blocks.some(isContentBearing)
}

/** An image that removes itself from layout if it fails to load. Block images
 * are on public CDNs, so they load directly (no proxy), matching the v3b
 * unfurl-preview behavior. */
function HideableImage({ src, alt, size }: { src: string; alt: string; size?: number }) {
  const [errored, setErrored] = useState(false)
  if (errored || !src) return null
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      style={{ maxWidth: size ?? 360, maxHeight: size ?? 300, objectFit: 'contain', borderRadius: 4 }}
      onError={() => setErrored(true)}
    />
  )
}

function renderTextObject(
  text: { Type: string; Text: string } | null,
  users: Record<string, User>,
  emoji: Record<string, string>,
) {
  if (!text || !text.Text) return null
  if (text.Type === 'mrkdwn') {
    return <Mrkdwn text={text.Text} users={users} emoji={emoji} />
  }
  return <>{text.Text}</>
}

function ContextElement({
  el,
  users,
  emoji,
}: {
  el: BlockElement
  users: Record<string, User>
  emoji: Record<string, string>
}) {
  if (el.Type === 'image') {
    return <HideableImage src={el.ImageURL} alt={el.AltText} size={18} />
  }
  return (
    <Text span size="xs" c="dimmed">
      {el.Type === 'mrkdwn' ? <Mrkdwn text={el.Text} users={users} emoji={emoji} /> : el.Text}
    </Text>
  )
}

export function BlockKitBlocks({ blocks, users, emoji }: BlockKitProps) {
  if (!blocks || blocks.length === 0) return null
  return (
    <Stack gap={6}>
      {blocks.map((b, i) => {
        switch (b.Type) {
          case 'section':
            return (
              <Group key={i} align="flex-start" wrap="nowrap" gap="sm">
                <Text size="sm" component="div" style={{ flex: 1, minWidth: 0 }}>
                  {renderTextObject(b.Text, users, emoji)}
                </Text>
                {b.Accessory && b.Accessory.Type === 'image' && (
                  <HideableImage src={b.Accessory.ImageURL} alt={b.Accessory.AltText} size={72} />
                )}
              </Group>
            )
          case 'context':
            return (
              <Group key={i} gap={6} align="center">
                {(b.Elements ?? []).map((el, j) => (
                  <ContextElement key={j} el={el} users={users} emoji={emoji} />
                ))}
              </Group>
            )
          case 'header':
            return (
              <Text key={i} size="md" fw={700} component="div">
                {renderTextObject(b.Text, users, emoji)}
              </Text>
            )
          case 'image':
            return <HideableImage key={i} src={b.ImageURL} alt={b.AltText} />
          case 'divider':
            return <hr key={i} style={{ border: 'none', borderTop: '1px solid var(--mantine-color-default-border)', margin: 0 }} />
          case 'rich_text':
            return (
              <Text key={i} size="sm" component="div">
                <RichText blocks={b.RichText} users={users} emoji={emoji} />
              </Text>
            )
          default:
            return null // "unsupported" and anything unknown render nothing
        }
      })}
    </Stack>
  )
}
