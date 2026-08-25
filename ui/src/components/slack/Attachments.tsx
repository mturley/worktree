import { useState } from 'react'
import { Anchor, Button, Group, Paper, Stack, Text, Tooltip } from '@mantine/core'
import { safeHref, imageProxy } from '../../api/slackApi'
import type { Attachment, User } from '../../api/slackApi'
import { Mrkdwn } from '../../lib/mrkdwn'
import { parseThreadUrl } from '../../lib/parseThreadUrl'
import { BlockKitBlocks, hasRenderableBlocks } from './BlockKit'
import { useThreadActions } from './ThreadActionsContext'

interface AttachmentsProps {
  attachments: Attachment[]
  users: Record<string, User>
  emoji: Record<string, string>
  onOpenThread: (url: string, opts: { background: boolean }) => void
}

// Slack attachment `Color` values come in both bare-hex ("36a64f") and
// already-hash-prefixed ("#7c0a02") forms. Normalize to exactly one leading
// `#` so we never emit an invalid "##..." CSS color, and fall back to a
// neutral gray when unset.
export function borderColor(color: string): string {
  const c = color.trim()
  if (!c) return '#888'
  return c.startsWith('#') ? c : '#' + c
}

export function Attachments({ attachments, users, emoji, onOpenThread }: AttachmentsProps) {
  return (
    <Stack gap="xs" mt={4}>
      {attachments.map((attachment, index) => {
        const isThreadUnfurl = attachment.IsThreadUnfurl || parseThreadUrl(attachment.FromURL) !== null
        if (isThreadUnfurl) {
          return (
            <ThreadUnfurlCard
              key={index}
              attachment={attachment}
              users={users}
              emoji={emoji}
              onOpenThread={onOpenThread}
            />
          )
        }
        return <WebUnfurlCard key={index} attachment={attachment} users={users} emoji={emoji} />
      })}
    </Stack>
  )
}

function ThreadUnfurlCard({
  attachment,
  users,
  emoji,
  onOpenThread,
}: {
  attachment: Attachment
  users: Record<string, User>
  emoji: Record<string, string>
  onOpenThread: (url: string, opts: { background: boolean }) => void
}) {
  const canOpen = parseThreadUrl(attachment.FromURL) !== null

  return (
    <Paper withBorder p="xs" radius="sm" style={{ maxWidth: 480 }}>
      <Stack gap={4}>
        {attachment.AuthorName && (
          <Text size="xs" fw={600}>
            {attachment.AuthorName}
          </Text>
        )}
        {attachment.Text && (
          <Text size="sm">
            <Mrkdwn text={attachment.Text} users={users} emoji={emoji} />
          </Text>
        )}
        {canOpen && (
          <Group>
            <ThreadUnfurlActions url={attachment.FromURL} onOpenThread={onOpenThread} />
          </Group>
        )}
      </Stack>
    </Paper>
  )
}

/**
 * Add / open / copy for a thread linked from inside another thread.
 *
 * "Add thread" is the useful default here: a thread worth linking is usually
 * one worth tracking, and adding it beats opening Slack, copying the link and
 * pasting it into the add-resource dialog. Opening in Slack stays available
 * beside it.
 */
function ThreadUnfurlActions({
  url,
  onOpenThread,
}: {
  url: string
  onOpenThread: (url: string, opts: { background: boolean }) => void
}) {
  const { requestAddThread, trackedThread, selectThread } = useThreadActions()
  const [copied, setCopied] = useState(false)

  // Derived from the resource list, not remembered locally: the button stays
  // correct across navigation, and for threads added from somewhere else.
  const tracked = trackedThread?.(url) ?? null

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be denied; the other two actions still work.
    }
  }

  return (
    <Stack gap={4}>
      <Button.Group className="compound-group">
        {tracked && selectThread ? (
          <Tooltip label="This worktree already tracks this thread — show it">
            <Button size="xs" variant="light" onClick={() => selectThread(tracked)}>
              Go to thread
            </Button>
          </Tooltip>
        ) : requestAddThread ? (
          <Tooltip label="Add this thread to the worktree">
            <Button size="xs" variant="light" onClick={() => requestAddThread(url)}>
              Add thread…
            </Button>
          </Tooltip>
        ) : null}
        <Tooltip label="Open in Slack">
          <Button
            size="xs"
            variant="light"
            onClick={(e) => onOpenThread(url, { background: e.metaKey || e.ctrlKey })}
          >
            Open in Slack
          </Button>
        </Tooltip>
        <Tooltip label={copied ? "Copied!" : "Copy link"}>
          <Button size="xs" variant="light" px="xs" aria-label="Copy link" onClick={() => void handleCopy()}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </Button>
        </Tooltip>
      </Button.Group>
    </Stack>
  )
}

function WebUnfurlCard({
  attachment,
  users,
  emoji,
}: {
  attachment: Attachment
  users: Record<string, User>
  emoji: Record<string, string>
}) {
  // Each image in the card (preview, service favicon, footer icon) tracks
  // its own load-error state independently, so a broken favicon doesn't
  // take down a working preview image, and vice versa.
  const [previewErrored, setPreviewErrored] = useState(false)
  const [serviceIconErrored, setServiceIconErrored] = useState(false)
  const [footerIconErrored, setFooterIconErrored] = useState(false)
  const imageSrc = attachment.ImageURL || attachment.ThumbURL

  // App unfurls (Confluence, Jira, etc. — is_app_unfurl) carry their content
  // in Block Kit `blocks`. Render nothing rather than an empty bordered card
  // when there's no title/text/service/footer/image and no renderable block
  // content. (The `color` field alone is not content.)
  const hasContent =
    !!attachment.Title ||
    !!attachment.Text ||
    !!attachment.ServiceName ||
    !!attachment.Footer ||
    !!imageSrc ||
    hasRenderableBlocks(attachment.Blocks)
  if (!hasContent) {
    return null
  }

  return (
    <Paper
      withBorder
      p="xs"
      radius="sm"
      style={{ maxWidth: 480, borderLeft: '3px solid ' + borderColor(attachment.Color) }}
    >
      <Stack gap={4}>
        {imageSrc && !previewErrored && (
          <img
            src={imageProxy(imageSrc)}
            alt=""
            width={attachment.ImageWidth > 0 ? attachment.ImageWidth : undefined}
            height={attachment.ImageHeight > 0 ? attachment.ImageHeight : undefined}
            style={{ maxWidth: 360, maxHeight: 300, objectFit: 'contain', borderRadius: 4 }}
            onError={() => setPreviewErrored(true)}
          />
        )}
        {attachment.ServiceName && (
          <Group gap={4}>
            {attachment.ServiceIcon && !serviceIconErrored && (
              <img
                src={imageProxy(attachment.ServiceIcon)}
                alt=""
                width={16}
                height={16}
                onError={() => setServiceIconErrored(true)}
              />
            )}
            <Text size="xs" c="dimmed">
              {attachment.ServiceName}
            </Text>
          </Group>
        )}
        {attachment.Title &&
          (safeHref(attachment.TitleLink) ? (
            <Anchor
              href={safeHref(attachment.TitleLink)}
              target="_blank"
              rel="noreferrer"
              size="sm"
              fw={600}
            >
              {attachment.Title}
            </Anchor>
          ) : (
            <Text size="sm" fw={600}>
              {attachment.Title}
            </Text>
          ))}
        {attachment.Text && (
          <Text size="sm">
            <Mrkdwn text={attachment.Text} users={users} emoji={emoji} />
          </Text>
        )}
        {attachment.Blocks && hasRenderableBlocks(attachment.Blocks) && (
          <BlockKitBlocks blocks={attachment.Blocks} users={users} emoji={emoji} />
        )}
        {attachment.Footer && (
          <Group gap={4}>
            {attachment.FooterIcon && !footerIconErrored && (
              <img
                src={imageProxy(attachment.FooterIcon)}
                alt=""
                width={14}
                height={14}
                onError={() => setFooterIconErrored(true)}
              />
            )}
            <Text size="xs" c="dimmed">
              {attachment.Footer}
            </Text>
          </Group>
        )}
      </Stack>
    </Paper>
  )
}
