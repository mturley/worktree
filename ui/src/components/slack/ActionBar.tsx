import { useState } from 'react'
import { ActionIcon, Button, Group, Text, Tooltip } from '@mantine/core'
import { relativeFromNow } from '../../lib/relativeTime'

interface ActionBarProps {
  onMarkRead: () => void
  markReadLoading: boolean
  markReadDisabled: boolean
  markReadDisabledReason?: string
  onOpenInSlack: () => void
  openInSlackDisabled: boolean
  onCopyLink: () => void
  onRefresh: () => void
  /** When the thread was last (re)loaded, for the "updated ... ago" label. */
  lastUpdated: Date | null
  /** Current time, ticked live by the caller so the label stays fresh. */
  now: Date
}

const COPIED_FEEDBACK_MS = 1500

/**
 * Mark read / Open in Slack / Refresh actions, shared by the thread header
 * and footer so both stay in sync.
 */
export function ActionBar({
  onMarkRead,
  markReadLoading,
  markReadDisabled,
  markReadDisabledReason,
  onOpenInSlack,
  openInSlackDisabled,
  onCopyLink,
  onRefresh,
  lastUpdated,
  now,
}: ActionBarProps) {
  const [copied, setCopied] = useState(false)

  function handleCopyLink() {
    if (openInSlackDisabled) {
      return
    }
    onCopyLink()
    setCopied(true)
    setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
  }

  return (
    <Group gap="xs" wrap="nowrap">
      <Tooltip label={markReadDisabled ? markReadDisabledReason ?? 'Thread is already read' : 'Mark thread read'}>
        <Button
          size="xs"
          variant="light"
          onClick={onMarkRead}
          loading={markReadLoading}
          disabled={markReadDisabled}
          styles={{ root: { flexShrink: 0 }, label: { whiteSpace: 'nowrap' } }}
        >
          Mark read
        </Button>
      </Tooltip>
      <Button.Group className="compound-group" style={{ flexShrink: 0 }}>
        <Tooltip label="Open in Slack">
          <Button
            size="xs"
            variant="light"
            onClick={onOpenInSlack}
            disabled={openInSlackDisabled}
            styles={{ root: { flexShrink: 0 }, label: { whiteSpace: 'nowrap' } }}
          >
            Open in Slack
          </Button>
        </Tooltip>
        <Tooltip label={copied ? 'Copied!' : 'Copy link to thread'}>
          <Button
            size="xs"
            variant="light"
            px="xs"
            onClick={handleCopyLink}
            disabled={openInSlackDisabled}
            aria-label="Copy link to thread"
            styles={{ root: { flexShrink: 0 }, label: { whiteSpace: 'nowrap' } }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </Button>
        </Tooltip>
      </Button.Group>
      <Tooltip label="Refresh">
        <ActionIcon variant="light" onClick={onRefresh} aria-label="Refresh thread" style={{ flexShrink: 0 }}>
          ↻
        </ActionIcon>
      </Tooltip>
      {lastUpdated && (
        <Text size="xs" c="dimmed">
          updated {relativeFromNow((lastUpdated.getTime() / 1000).toString(), now)}
        </Text>
      )}
    </Group>
  )
}
