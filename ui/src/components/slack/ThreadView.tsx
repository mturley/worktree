import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Alert, Button, Divider, Group, Paper, Skeleton, Stack, Text, Tooltip } from '@mantine/core'
import type { UseThreadResult } from '../../hooks/useThread'
import { useNow } from '../../hooks/useNow'
import { getConfig, markRead, markUnread, postReply, toggleReaction } from '../../api/slackApi'
import { deriveThreadMeta } from '../../lib/deriveThreadMeta'
import { fallbackTitle } from '../../lib/fallbackTitle'
import { resolveMentionsToText } from '../../lib/resolveMentions'
import { applyReactionToggle } from '../../lib/reactionToggle'
import { relativeFromNow } from '../../lib/relativeTime'
import { computeUnreadPatch } from '../../lib/unreadPatch'
import { defaultTabName, type Tab } from '../../state/tabs'
import { ActionBar } from './ActionBar'
import { Composer } from './Composer'
import { EditTabModal } from './EditTabModal'
import { Message } from './Message'

interface PendingReply {
  localId: string
  text: string
  status: 'sending' | 'failed'
  error?: string
}

interface ThreadViewProps {
  tab: Tab
  thread: UseThreadResult
  onUpdateTab: (id: string, updates: { name: string; description: string }) => void
  onOpenThread: (url: string, opts: { background: boolean }) => void
  /**
   * Optional control rendered beside the edit affordance in the header card
   * (the resource remove control, when this thread is shown as a selected
   * worktree resource). Kept as a slot so ThreadView stays presentational and
   * knows nothing about resources or the API.
   */
  headerAction?: React.ReactNode
}

// Cached across renders/tabs: the workspace domain never changes for a
// running instance, so there's no need to refetch /api/slack-config per tab.
let cachedWorkspaceDomain: string | null = null

// workspaceDomain is already the full host (e.g. "myteam.slack.com" or
// "redhat.enterprise.slack.com") as returned by team.info via /api/slack-config —
// do NOT append ".slack.com" or it produces a broken double-domain.
export function openInSlackUrl(channel: string, threadTs: string, latestTs: string, workspaceDomain: string): string {
  const pMessageId = latestTs.replace('.', '')
  return `https://${workspaceDomain}/archives/${channel}/p${pMessageId}?thread_ts=${threadTs}&cid=${channel}`
}

export function ThreadView({ tab, thread, onUpdateTab, onOpenThread, headerAction }: ThreadViewProps) {
  const { data, status, error, authExpired, lastUpdated, refresh, applyLocal } = thread
  const now = useNow()
  const [workspaceDomain, setWorkspaceDomain] = useState<string | null>(cachedWorkspaceDomain)
  const [marking, setMarking] = useState(false)
  const [markError, setMarkError] = useState<string | undefined>(undefined)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [editOpened, setEditOpened] = useState(false)
  const [pending, setPending] = useState<PendingReply[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevMessageCount = useRef(0)
  const pendingLocalId = useRef(0)

  // Tolerance (px) for treating the scroll container as "at the bottom" —
  // avoids flicker from sub-pixel layout rounding.
  const AT_BOTTOM_THRESHOLD_PX = 8

  function checkIsAtBottom(container: HTMLDivElement): boolean {
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    return distanceFromBottom <= AT_BOTTOM_THRESHOLD_PX
  }

  function handleScroll() {
    const container = scrollRef.current
    if (!container) {
      return
    }
    setIsAtBottom(checkIsAtBottom(container))
  }

  useEffect(() => {
    if (cachedWorkspaceDomain) {
      return
    }
    getConfig()
      .then((cfg) => {
        cachedWorkspaceDomain = cfg.workspaceDomain
        setWorkspaceDomain(cfg.workspaceDomain)
      })
      .catch(() => {
        // Open-in-Slack simply stays disabled if config can't be fetched.
      })
  }, [])

  // Track whether the user is scrolled away from the bottom so live
  // updates can show a subtle "new/more messages" affordance instead of
  // silently appending below the fold. When a new message arrives while the
  // user was already at the bottom, auto-scroll to keep following the
  // conversation instead of leaving them stranded above new content.
  useEffect(() => {
    const messages = data?.messages ?? []
    const container = scrollRef.current
    if (messages.length > prevMessageCount.current && container && checkIsAtBottom(container)) {
      container.scrollTop = container.scrollHeight
    }
    prevMessageCount.current = messages.length
    // Recompute at-bottom state after content changes (e.g. a short thread
    // that just became scrollable, or new messages changing scrollHeight).
    if (container) {
      setIsAtBottom(checkIsAtBottom(container))
    }
  }, [data?.messages])

  function scrollToBottom() {
    const container = scrollRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
    setIsAtBottom(true)
  }

  const meta = data ? deriveThreadMeta(data) : undefined
  const hasUnread = !!meta && meta.hasUnread

  async function handleMarkRead() {
    if (!data || data.messages.length === 0 || !hasUnread) {
      return
    }
    const latest = data.messages[data.messages.length - 1]
    // Optimistically clear the unread state so the divider disappears and
    // the button disables immediately; the next SSE poll reconciles with
    // the server's own unreadIndex/lastRead.
    applyLocal((d) => ({ ...d, unreadIndex: -1, lastRead: latest.TS }))
    setMarking(true)
    setMarkError(undefined)
    try {
      await markRead(tab.channel, tab.threadTs, latest.TS)
    } catch (err) {
      setMarkError(err instanceof Error ? err.message : String(err))
      refresh()
    } finally {
      setMarking(false)
    }
  }

  async function handleMarkUnread(ts: string) {
    if (data) {
      // Optimistically move the "New" divider above the clicked message
      // without refetching, so scroll position is preserved.
      const patch = computeUnreadPatch(data.messages, ts)
      applyLocal((d) => ({ ...d, unreadIndex: patch.unreadIndex, lastRead: patch.lastRead }))
    }
    setMarkError(undefined)
    try {
      await markUnread(tab.channel, tab.threadTs, ts)
    } catch (err) {
      setMarkError(err instanceof Error ? err.message : String(err))
      refresh()
    }
  }

  async function handleToggleReaction(ts: string, name: string, add: boolean) {
    if (!data) {
      return
    }
    const userId = data.currentUserId
    applyLocal((d) => ({ ...d, messages: applyReactionToggle(d.messages, ts, name, userId, add) }))
    try {
      await toggleReaction(tab.channel, tab.threadTs, ts, name, add)
    } catch {
      refresh() // silent rollback (covers a disallowed-channel 403)
    }
  }

  function handleOpenInSlack() {
    if (!data || data.messages.length === 0 || !workspaceDomain) {
      return
    }
    const latest = data.messages[data.messages.length - 1]
    window.open(openInSlackUrl(tab.channel, tab.threadTs, latest.TS, workspaceDomain), '_blank', 'noreferrer')
  }

  function handleCopyLink() {
    if (!data || data.messages.length === 0 || !workspaceDomain) {
      return
    }
    const latest = data.messages[data.messages.length - 1]
    navigator.clipboard.writeText(openInSlackUrl(tab.channel, tab.threadTs, latest.TS, workspaceDomain))
  }

  function handleSaveDetails(id: string, name: string, description: string) {
    onUpdateTab(id, { name, description })
  }

  async function handleSend(text: string) {
    const localId = `pending-${pendingLocalId.current++}`
    setPending((prev) => [...prev, { localId, text, status: 'sending' }])
    try {
      const msg = await postReply(tab.channel, tab.threadTs, text)
      setPending((prev) => prev.filter((p) => p.localId !== localId))
      // Append the new message immediately for a snappy feel; dedupe by TS
      // since the next SSE push will include it in the full message list.
      // The backend also marks the thread read on send.
      applyLocal((d) => ({
        ...d,
        messages: d.messages.some((m) => m.TS === msg.TS) ? d.messages : [...d.messages, msg],
        unreadIndex: -1,
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setPending((prev) =>
        prev.map((p) => (p.localId === localId ? { ...p, status: 'failed' as const, error: message } : p)),
      )
    }
  }

  function handleRetry(localId: string) {
    const entry = pending.find((p) => p.localId === localId)
    if (!entry) {
      return
    }
    setPending((prev) => prev.filter((p) => p.localId !== localId))
    void handleSend(entry.text)
  }

  function handleDismiss(localId: string) {
    setPending((prev) => prev.filter((p) => p.localId !== localId))
  }

  function renderPendingRow(entry: PendingReply) {
    return (
      <Group key={entry.localId} align="flex-start" wrap="nowrap" gap="sm" opacity={entry.status === 'sending' ? 0.6 : 1}>
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" component="div" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {entry.text}
          </Text>
          {entry.status === 'sending' && (
            <Text size="xs" c="dimmed" fs="italic">
              Sending…
            </Text>
          )}
          {entry.status === 'failed' && (
            <Group gap="xs" wrap="wrap">
              <Text size="xs" c="red">
                {entry.error || 'Failed to send'}
              </Text>
              <Button size="compact-xs" variant="light" onClick={() => handleRetry(entry.localId)}>
                Retry
              </Button>
              <Button size="compact-xs" variant="subtle" color="gray" onClick={() => handleDismiss(entry.localId)}>
                Dismiss
              </Button>
            </Group>
          )}
        </Stack>
      </Group>
    )
  }

  const hasCustomTitle = tab.name !== defaultTabName(tab.channel, tab.threadTs)
  // Resolve mentions BEFORE truncating: truncating first would slice raw
  // <@U123> tokens mid-id, and the 60-char budget should be spent on the
  // resolved text the reader actually sees.
  const fallbackTitleText =
    fallbackTitle(resolveMentionsToText(data?.messages[0]?.Text, data?.users)) || '(no title)'

  const fromLine = meta?.author
    ? meta.channelName
      ? `From ${meta.author} in #${meta.channelName}`
      : `From ${meta.author}`
    : undefined

  const startedLine =
    meta?.startedTs && meta.activeTs
      ? `Started ${relativeFromNow(meta.startedTs, now)} · Active ${relativeFromNow(meta.activeTs, now)}`
      : undefined

  const actionBar = (
    <ActionBar
      onMarkRead={handleMarkRead}
      markReadLoading={marking}
      markReadDisabled={!data || !hasUnread}
      markReadDisabledReason={data && !hasUnread ? 'Thread is already read' : undefined}
      onOpenInSlack={handleOpenInSlack}
      openInSlackDisabled={!data || data.messages.length === 0 || !workspaceDomain}
      onCopyLink={handleCopyLink}
      onRefresh={refresh}
      lastUpdated={lastUpdated}
      now={now}
    />
  )

  return (
    <Stack gap="sm" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/*
        The thread's own title/description/meta, carded to match the PR/Jira
        detail card. There is deliberately no separate summary card above the
        thread — this IS that card.
      */}
      <Paper p="xs" withBorder>
      <Stack gap={2}>
        <Group gap="xs" wrap="nowrap" align="center">
          {hasCustomTitle ? (
            <Text fw={700} size="lg">
              {tab.name}
            </Text>
          ) : (
            <Text fw={700} size="lg" c="dimmed" fs="italic">
              {fallbackTitleText}
            </Text>
          )}
          <Tooltip label={hasCustomTitle ? 'Edit title/description' : 'Add a title/description'}>
            <ActionIcon
              variant="subtle"
              size="sm"
              onClick={() => setEditOpened(true)}
              aria-label="Edit tab details"
            >
              ✎
            </ActionIcon>
          </Tooltip>
          {headerAction ? <div style={{ marginLeft: 'auto' }}>{headerAction}</div> : null}
        </Group>
        {tab.description ? (
          <Text size="sm" c="dimmed">
            {tab.description}
          </Text>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            No description
          </Text>
        )}
        {fromLine && (
          <Text size="xs" c="dimmed">
            {fromLine}
          </Text>
        )}
        {startedLine && (
          <Text size="xs" c="dimmed">
            {startedLine}
          </Text>
        )}
      </Stack>
      </Paper>

      {markError && (
        <Alert color="red" variant="light">
          {markError}
        </Alert>
      )}

      {status === 'loading' && (
        <Stack gap="md">
          <Skeleton height={50} />
          <Skeleton height={50} />
          <Skeleton height={50} />
        </Stack>
      )}

      {status === 'error' && (
        <Alert color="red" title={authExpired ? 'Authentication expired' : 'Failed to load thread'}>
          {authExpired
            ? 'Your Slack session has expired. Re-run worktree setup to authenticate again.'
            : error}
        </Alert>
      )}

      {status === 'ready' && data && data.messages.length === 0 && (
        <Stack gap="md">
          <Text c="dimmed">No messages in this thread.</Text>
          {pending.map(renderPendingRow)}
        </Stack>
      )}

      {status === 'ready' && data && data.messages.length > 0 && (
        <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
          <Stack
            ref={scrollRef}
            onScroll={handleScroll}
            gap="md"
            style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4, paddingBottom: 64 }}
          >
            {data.messages.map((message, index) => (
              <div key={message.TS}>
                {hasUnread && index === data.unreadIndex && (
                  <Divider label="New" labelPosition="center" color="blue" my="sm" />
                )}
                <Message
                  message={message}
                  users={data.users}
                  emoji={data.emoji}
                  currentUserId={data.currentUserId}
                  onMarkUnread={handleMarkUnread}
                  onToggleReaction={handleToggleReaction}
                  onOpenThread={onOpenThread}
                />
              </div>
            ))}
            {pending.map(renderPendingRow)}
          </Stack>
          {!isAtBottom && (
            <Button
              size="xs"
              variant={hasUnread ? 'filled' : 'default'}
              onClick={scrollToBottom}
              style={{ position: 'absolute', bottom: 56, left: '50%', transform: 'translateX(-50%)' }}
            >
              {hasUnread ? 'New messages ↓' : 'More messages ↓'}
            </Button>
          )}
          <Paper
            shadow="md"
            p="xs"
            radius="md"
            withBorder
            style={{
              position: 'absolute',
              bottom: 8,
              left: '50%',
              transform: 'translateX(-50%)',
              backgroundColor: 'rgba(37, 38, 43, 0.9)',
              backdropFilter: 'blur(6px)',
              width: 'max-content',
              maxWidth: 'calc(100% - 16px)',
              overflowX: 'auto',
            }}
          >
            {actionBar}
          </Paper>
        </div>
      )}

      {status === 'ready' && data && <Composer onSend={handleSend} />}

      <EditTabModal opened={editOpened} tab={tab} onClose={() => setEditOpened(false)} onSave={handleSaveDetails} />
    </Stack>
  )
}
