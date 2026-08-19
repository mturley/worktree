import { Badge, Group, Stack, Text, Tooltip } from '@mantine/core'
import { emojiProxy } from '../../api/slackApi'
import type { Reaction, User } from '../../api/slackApi'
import { resolveEmoji, type ResolvedEmoji } from '../../lib/emoji'

/**
 * Builds a Slack-style "who reacted" string from a reaction's user IDs.
 * Resolves each ID to its display name (falling back to real name) via the
 * thread's `users` map. Reactors not in the map (the map is filtered to thread
 * participants, so a reactor who never posted in-thread is absent) can't be
 * named, so:
 *  - known names are listed, comma-separated;
 *  - unresolved reactors are summarized as "and N other(s)";
 *  - if NONE resolve, fall back to "N reacted".
 * Returns "" for a null/empty list.
 */
export function reactorNames(userIDs: string[] | null, users: Record<string, User>): string {
  if (!userIDs || userIDs.length === 0) {
    return ''
  }
  const named: string[] = []
  let unknown = 0
  for (const id of userIDs) {
    const u = users[id]
    const name = u ? u.DisplayName || u.RealName : ''
    if (name) {
      named.push(name)
    } else {
      unknown++
    }
  }
  if (named.length === 0) {
    return `${userIDs.length} reacted`
  }
  const base = named.join(', ')
  if (unknown === 0) {
    return base
  }
  return `${base} and ${unknown} ${unknown === 1 ? 'other' : 'others'}`
}

/** Renders a resolved emoji at an arbitrary size (used both for the compact
 * pill glyph and the large tooltip preview). */
function EmojiGlyph({
  resolved,
  name,
  size,
}: {
  resolved: ResolvedEmoji
  name: string
  size: string
}) {
  if (resolved.kind === 'image') {
    return (
      <img
        src={emojiProxy(resolved.url)}
        alt={`:${name}:`}
        style={{ height: size, verticalAlign: 'middle' }}
      />
    )
  }
  if (resolved.kind === 'unicode') {
    return <span style={{ fontSize: size, verticalAlign: 'middle' }}>{resolved.char}</span>
  }
  return <span style={{ fontSize: size }}>{resolved.text}</span>
}

/**
 * A single reaction pill. Hovering shows a Slack-style tooltip with a large
 * emoji preview, the `:name:` shortcode, and who reacted.
 */
export function ReactionPill({
  reaction,
  users,
  emoji,
  mine,
  onToggle,
}: {
  reaction: Reaction
  users: Record<string, User>
  emoji: Record<string, string>
  mine: boolean
  onToggle?: (name: string, add: boolean) => void
}) {
  const resolved = resolveEmoji(reaction.Name, undefined, emoji)
  const who = reactorNames(reaction.UserIDs, users)

  const tooltipLabel = (
    <Stack gap={4} align="center" p={4}>
      <EmojiGlyph resolved={resolved} name={reaction.Name} size="2.75em" />
      <Text size="xs" fw={600} ta="center">
        :{reaction.Name}:
      </Text>
      {who && (
        <Text size="xs" c="dimmed" ta="center">
          {who}
        </Text>
      )}
    </Stack>
  )

  return (
    <Tooltip label={tooltipLabel} withArrow multiline w={220} position="top" events={{ hover: true, focus: true, touch: true }}>
      <Badge
        variant={mine ? 'filled' : 'light'}
        color={mine ? 'blue' : 'gray'}
        size="md"
        radius="sm"
        {...(onToggle
          ? { style: { cursor: 'pointer' }, onClick: () => onToggle(reaction.Name, !mine) }
          : {})}
      >
        <Group component="span" gap={4} align="center" wrap="nowrap">
          <EmojiGlyph resolved={resolved} name={reaction.Name} size="1.4em" />
          <span>{reaction.Count}</span>
        </Group>
      </Badge>
    </Tooltip>
  )
}
