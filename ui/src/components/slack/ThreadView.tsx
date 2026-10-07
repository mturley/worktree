import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Button, Group, Paper, Skeleton, Stack, Text } from '@mantine/core'
import { useQueryClient } from '@tanstack/react-query'
import type { UseThreadResult } from '../../hooks/useThread'
import { useNow } from '../../hooks/useNow'
import { getConfig, markRead, markUnread, postReply, toggleReaction } from '../../api/slackApi'
import { deriveThreadMeta } from '../../lib/deriveThreadMeta'
import { SlackGroupsContext } from './Mention'
import { applyReactionToggle } from '../../lib/reactionToggle'
import { computeUnreadPatch } from '../../lib/unreadPatch'
import type { Tab } from '../../state/tabs'
import { ActionBar } from './ActionBar'
import { Composer, type ComposerProps } from './Composer'
import { Message } from './Message'
import { UnreadDivider } from '../UnreadDivider'

interface PendingReply {
  localId: string
  text: string
  status: 'sending' | 'failed'
  error?: string
}

interface ThreadViewProps {
  tab: Tab
  thread: UseThreadResult
  onOpenThread: (url: string, opts: { background: boolean }) => void
  /** Height (px) of whatever sticks over the top of the page — the worktree
   *  page's header, including its details card when shown. The initial
   *  scroll keeps the unread divider below it. */
  topInset?: number
  /** Test-only escape hatch, forwarded to the Composer: jsdom's contenteditable
   *  support is too thin for simulated typing to reach Lexical, so tests
   *  drive the editor directly via its own API once they have this
   *  reference. Unused in production. */
  onComposerEditorReady?: ComposerProps['onEditorReady']
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

export function ThreadView({ tab, thread, onOpenThread, topInset = 0, onComposerEditorReady }: ThreadViewProps) {
  const { data, status, error, authExpired, lastUpdated, refresh, applyLocal } = thread
  const now = useNow()
  const [workspaceDomain, setWorkspaceDomain] = useState<string | null>(cachedWorkspaceDomain)
  const [marking, setMarking] = useState(false)
  const [markError, setMarkError] = useState<string | undefined>(undefined)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [pending, setPending] = useState<PendingReply[]>([])
  const unreadDividerRef = useRef<HTMLDivElement>(null)
  const listEndRef = useRef<HTMLDivElement>(null)
  const threadEndRef = useRef<HTMLDivElement>(null)
  // isAtBottom as of the last observer report, readable from the follow
  // effect without re-running it whenever the reader scrolls.
  const isAtBottomRef = useRef(true)
  const prevMessageCount = useRef(0)
  // Which thread the message list has been initially positioned for. Reset
  // whenever the list unmounts (loading, refresh, empty), so it is positioned
  // again the next time messages render.
  const positionedFor = useRef<string | null>(null)
  const pendingLocalId = useRef(0)

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

  // Initial position: once a thread's messages first render, open at the
  // unread divider if there is one, else at the end of the thread. Live
  // updates after that must not move the user, so this runs once per thread.
  // A layout effect, so the page never paints at the wrong spot first.
  //
  // This scrolls the PAGE, not the message list: the worktree page lets the
  // document scroll, so the list grows to fit and has nothing to scroll.
  // scrollIntoView moves whichever ancestors actually scroll.
  //
  // The divider lands a quarter of the way down the space BELOW the sticky
  // page header (topInset): high enough to show plenty of what's new, low
  // enough to keep a little read context above it. scrollIntoView can only
  // align to an edge or the centre, but it honours scroll-margin, so a top
  // margin of the header plus that quarter stops the divider exactly there.
  // Set at scroll time, as it depends on the window's current height.
  const threadKey = `${tab.channel}:${tab.threadTs}`
  const hasMessages = status === 'ready' && !!data && data.messages.length > 0
  useLayoutEffect(() => {
    if (!hasMessages) {
      positionedFor.current = null
      return
    }
    if (positionedFor.current === threadKey) {
      return
    }
    positionedFor.current = threadKey
    // jsdom (and some older browsers) don't implement scrollIntoView at all.
    const unreadDivider = unreadDividerRef.current
    if (unreadDivider) {
      const visible = window.innerHeight - topInset
      unreadDivider.style.scrollMarginTop = `${topInset + visible / 4}px`
      unreadDivider.scrollIntoView?.({ block: 'start' })
    } else {
      threadEndRef.current?.scrollIntoView?.({ block: 'end' })
    }
  }, [threadKey, hasMessages, topInset])

  // Track whether the reader is at the end of the thread so live updates can
  // show a "new/more messages" affordance instead of silently appending below
  // the fold. The page scrolls, not the list (see above), so "at the end" is
  // whether the end of the message list is on screen — which an
  // IntersectionObserver reports without a scroll listener on the window.
  // The small bottom margin absorbs sub-pixel rounding at the very end.
  useEffect(() => {
    const listEnd = listEndRef.current
    if (!hasMessages || !listEnd || typeof IntersectionObserver === 'undefined') {
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        isAtBottomRef.current = entry.isIntersecting
        setIsAtBottom(entry.isIntersecting)
      },
      { rootMargin: '0px 0px 8px 0px' },
    )
    observer.observe(listEnd)
    return () => observer.disconnect()
  }, [threadKey, hasMessages])

  // When a new message arrives while the reader was at the end, keep
  // following the conversation instead of leaving them stranded above it.
  // Not on a thread's first render (prevMessageCount 0): the initial
  // position above owns that, and would otherwise lose the unread divider.
  useEffect(() => {
    const count = data?.messages.length ?? 0
    if (prevMessageCount.current > 0 && count > prevMessageCount.current && isAtBottomRef.current) {
      threadEndRef.current?.scrollIntoView?.({ block: 'end' })
    }
    prevMessageCount.current = count
  }, [data?.messages])

  function scrollToBottom() {
    threadEndRef.current?.scrollIntoView?.({ block: 'end' })
  }

  const qc = useQueryClient()
  // Every unread surface outside this view — resource cards, timeline dots,
  // the worktree badge and favicon — reads the poller's cached thread state.
  // The server re-polls the thread before answering a read-state write, so
  // once one lands those only need to refetch to show it.
  function refreshUnreadSurfaces() {
    void qc.invalidateQueries({ queryKey: ['worktrees'] })
    void qc.invalidateQueries({ queryKey: ['resources'] })
    void qc.invalidateQueries({ queryKey: ['timeline'] })
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
      refreshUnreadSurfaces()
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
      refreshUnreadSurfaces()
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

  // Copies a link to the thread's first message, matching the copy button on
  // the resource card above the thread (unlike "Open in Slack", which jumps
  // to the latest reply).
  function handleCopyLink() {
    handleCopyMessageLink(tab.threadTs)
  }

  function handleCopyMessageLink(ts: string) {
    if (!workspaceDomain) {
      return
    }
    navigator.clipboard.writeText(openInSlackUrl(tab.channel, tab.threadTs, ts, workspaceDomain)).catch(() => {
      // Clipboard access can be denied; failing silently beats an error
      // state on a convenience.
    })
  }


  async function handleSend(text: string) {
    const localId = `pending-${pendingLocalId.current++}`
    setPending((prev) => [...prev, { localId, text, status: 'sending' }])
    try {
      const msg = await postReply(tab.channel, tab.threadTs, text)
      setPending((prev) => prev.filter((p) => p.localId !== localId))
      // The server marks the thread read on send and re-polls it.
      refreshUnreadSurfaces()
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

  // Resolve mentions BEFORE truncating: truncating first would slice raw
  // <@U123> tokens mid-id, and the 60-char budget should be spent on the
  // resolved text the reader actually sees.



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
    // Provide the workspace group directory once for the whole thread: every
    // mention below resolves subteam ids against it via context.
    <SlackGroupsContext.Provider value={data?.groups ?? {}}>
    <Stack gap="sm" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/*
        No header here: the shared ResourceCard above this thread carries the
        title, description, channel/author, timestamps, and the open/copy,
        remove and edit controls for every resource type alike.
      */}

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
        <div>
          <Stack gap="md" style={{ paddingRight: 4 }}>
            {data.messages.map((message, index) => (
              <div key={message.TS}>
                {hasUnread && index === data.unreadIndex && (
                  // The scroll target is the divider alone, not its row, so
                  // that it is the divider that lands on the target line.
                  <div ref={unreadDividerRef}>
                    <UnreadDivider />
                  </div>
                )}
                <Message
                  message={message}
                  users={data.users}
                  emoji={data.emoji}
                  currentUserId={data.currentUserId}
                  onMarkUnread={handleMarkUnread}
                  onCopyLink={workspaceDomain ? handleCopyMessageLink : undefined}
                  onToggleReaction={handleToggleReaction}
                  onOpenThread={onOpenThread}
                />
              </div>
            ))}
            {pending.map(renderPendingRow)}
            <div ref={listEndRef} />
          </Stack>
          {/*
            The action bar and the jump button float at the bottom of the
            WINDOW while the thread runs past it, and settle under the last
            message at the end: sticky, since the page is what scrolls. Its
            parent is this wrapper, so it never floats outside the thread.
          */}
          <div
            style={{
              position: 'sticky',
              bottom: 8,
              zIndex: 2,
              marginTop: 'var(--mantine-spacing-md)',
              display: 'flex',
              justifyContent: 'center',
            }}
          >
            {!isAtBottom && (
              <Button
                size="xs"
                variant={hasUnread ? 'filled' : 'default'}
                onClick={scrollToBottom}
                // Above the bar, out of flow: showing and hiding it must not
                // change the page's height under the reader.
                style={{ position: 'absolute', bottom: '100%', marginBottom: 8 }}
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
        </div>
      )}

      {status === 'ready' && data && (
        <Composer
          onSend={handleSend}
          channel={data.channel}
          users={data.users}
          groups={data.groups ?? {}}
          onEditorReady={onComposerEditorReady}
        />
      )}
      <div ref={threadEndRef} />
    </Stack>
    </SlackGroupsContext.Provider>
  )
}
