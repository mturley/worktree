import { useState } from 'react'
import { ActionIcon, Avatar, Group, Stack, Text, Tooltip } from '@mantine/core'
import { avatarProxy } from '../../api/slackApi'
import type { Message as MessageData, User } from '../../api/slackApi'
import { Mrkdwn } from '../../lib/mrkdwn'
import { formatMessageTimestamp } from '../../lib/relativeTime'
import { Attachments } from './Attachments'
import { FileAttachments } from './FileAttachments'
import { ReactionPill } from './ReactionPill'
import { RichText } from './RichText'

interface MessageProps {
  message: MessageData
  users: Record<string, User>
  emoji: Record<string, string>
  /** The signed-in user's ID, used to highlight reactions they made. */
  currentUserId?: string
  /** Called with the message's ts when the "mark unread from here" hover action is clicked. */
  onMarkUnread?: (ts: string) => void
  /** Called when a reaction pill is clicked to toggle the current user's reaction. */
  onToggleReaction?: (ts: string, name: string, add: boolean) => void
  /**
   * Called to open a thread link (e.g. from an unfurled attachment) as a
   * tab. Threaded through to the Attachments renderer.
   */
  onOpenThread?: (url: string, opts: { background: boolean }) => void
}

export function Message({
  message,
  users,
  emoji,
  currentUserId,
  onMarkUnread,
  onToggleReaction,
  onOpenThread,
}: MessageProps) {
  const user = users[message.UserID]
  const displayName = user?.DisplayName || user?.RealName || message.UserID
  const [hovered, setHovered] = useState(false)

  return (
    <Group
      align="flex-start"
      wrap="nowrap"
      gap="sm"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Avatar src={user?.Avatar72 ? avatarProxy(user.Avatar72) : undefined} radius="xl" size="md">
        {displayName.slice(0, 1).toUpperCase()}
      </Avatar>
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Group gap="xs" align="baseline">
          <Text fw={600} size="sm">
            {displayName}
          </Text>
          <Text size="xs" c="dimmed">
            {formatMessageTimestamp(message.TS)}
          </Text>
          {message.Edited && (
            <Text size="xs" c="dimmed">
              (edited)
            </Text>
          )}
          {onMarkUnread && (
            <Tooltip label="Mark unread from here">
              <ActionIcon
                variant="subtle"
                color="gray"
                size="xs"
                aria-label="Mark unread from here"
                onClick={() => onMarkUnread(message.TS)}
                style={{ opacity: hovered ? 1 : 0, transition: 'opacity 100ms ease' }}
              >
                ●
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        <Text size="sm" component="div" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {message.Blocks && message.Blocks.length > 0 ? (
            <RichText blocks={message.Blocks} users={users} emoji={emoji} />
          ) : (
            <Mrkdwn text={message.Text} users={users} emoji={emoji} />
          )}
        </Text>
        {message.Files && message.Files.length > 0 && <FileAttachments files={message.Files} />}
        {message.Attachments && message.Attachments.length > 0 && (
          <Attachments
            attachments={message.Attachments}
            users={users}
            emoji={emoji}
            onOpenThread={onOpenThread ?? (() => {})}
          />
        )}
        {message.Reactions && message.Reactions.length > 0 && (
          <Group gap={4} mt={2}>
            {message.Reactions.map((reaction) => (
              <ReactionPill
                key={reaction.Name}
                reaction={reaction}
                users={users}
                emoji={emoji}
                mine={!!currentUserId && (reaction.UserIDs?.includes(currentUserId) ?? false)}
                onToggle={
                  onToggleReaction && currentUserId
                    ? (name, add) => onToggleReaction(message.TS, name, add)
                    : undefined
                }
              />
            ))}
          </Group>
        )}
      </Stack>
    </Group>
  )
}
