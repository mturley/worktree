import type { CSSProperties } from "react"
import { Group, Stack, Text } from "@mantine/core"
import type { TabMeta } from "../../hooks/useTabMetas"
import { fallbackTitle } from "../../lib/fallbackTitle"
import { relativeFromNow } from "../../lib/relativeTime"

interface ThreadRailLabelProps {
  /** The thread's display name; a custom name if the user set one. */
  name: string
  /** Whether `name` is a user-set custom title (vs the default channel:ts). */
  hasCustomTitle: boolean
  meta: TabMeta | undefined
  now: Date
}

const unreadDotStyle: CSSProperties = {
  display: "inline-block",
  width: 8,
  height: 8,
  borderRadius: "50%",
  backgroundColor: "var(--mantine-color-blue-5)",
  flexShrink: 0,
  marginTop: 6,
}

// Mirrors the removed slack-mini TabBar's `infoLines`: a "From <author> in
// #<channel>" line plus a "Started <ts> · Active <ts>" line, degrading to
// loading/error/empty states based on the tab meta.
function infoLines(meta: TabMeta | undefined, now: Date): { from: string; started?: string } {
  if (!meta || meta.status === "loading") {
    return { from: "Loading…" }
  }
  if (meta.status === "error") {
    return { from: "Unable to load details" }
  }
  const from = meta.author
    ? meta.channelName
      ? `From ${meta.author} in #${meta.channelName}`
      : `From ${meta.author}`
    : "No messages yet"
  const started =
    meta.startedTs && meta.activeTs
      ? `Started ${relativeFromNow(meta.startedTs, now)} · Active ${relativeFromNow(meta.activeTs, now)}`
      : undefined
  return { from, started }
}

/**
 * Multi-line label for a Slack thread in the tab rail: the thread name (or a
 * first-message preview for untitled threads), an unread dot, and dimmed
 * author/channel + started/active lines. Re-ported from the removed
 * slack-mini `TabBar` so the resource-scoped Slack tab keeps the same
 * at-a-glance thread summaries.
 */
export function ThreadRailLabel({ name, hasCustomTitle, meta, now }: ThreadRailLabelProps) {
  const { from, started } = infoLines(meta, now)
  const showUnreadDot = meta?.status === "ready" && meta.hasUnread
  // Untitled threads: while meta is loading show a dimmed placeholder; once
  // ready, preview the first message, or "(no title)" if there's none.
  const untitledText =
    !meta || meta.status === "loading" ? "…" : fallbackTitle(meta.firstMessageText) || "(no title)"

  return (
    <Group gap={6} wrap="nowrap" align="flex-start">
      {showUnreadDot && (
        <span data-testid="thread-unread-dot" aria-label="Unread messages" style={unreadDotStyle} />
      )}
      <Stack gap={2} style={{ minWidth: 0 }}>
        {hasCustomTitle ? (
          <Text fw={700} size="sm" style={{ wordBreak: "break-all" }}>
            {name}
          </Text>
        ) : (
          <Text size="sm" c="dimmed" fs="italic" style={{ wordBreak: "break-all" }}>
            {untitledText}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          {from}
        </Text>
        {started && (
          <Text size="xs" c="dimmed">
            {started}
          </Text>
        )}
      </Stack>
    </Group>
  )
}
