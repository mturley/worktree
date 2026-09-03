import { Anchor, Button, Center, Group, Stack, Title } from "@mantine/core"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ResourceDTO } from "../api/types"
import { useWorktreeTimeline } from "../hooks/useTimeline"
import { api } from "../api/client"
import { ResourceCard } from "./ResourceCard"
import { SlackThreadPane } from "./SlackThreadPane"
import { TimelineFeed } from "./TimelineFeed"
import { serviceName } from "./ResourceActions"

interface ResourceDetailPaneProps {
  path: string
  resource: ResourceDTO
  /** Supplied only on narrow viewports, where this pane is a drilldown. */
  onBack?: () => void
  onRemoved?: () => void
  /** Refetch the worktree's resources (used after a Slack details save). */
  onResourceChanged?: () => void
}

/**
 * The PR/Jira body: a fuller summary of the resource above an activity feed
 * filtered to just that resource.
 *
 * Split into its own component so the timeline query is only issued for the
 * resource types that actually need it — a Slack thread must not fire a
 * filtered-timeline fetch it will never render.
 */
function TimelineBody({
  path,
  resource,
  onRemoved,
  onResourceChanged,
}: {
  path: string
  resource: ResourceDTO
  onRemoved?: () => void
  onResourceChanged?: () => void
}) {
  const timeline = useWorktreeTimeline(path, { type: resource.type, id: resource.id })
  const qc = useQueryClient()
  const unreadCount = resource.unread_count ?? 0
  // The newest event the user can actually see. Sent as through_ts so events
  // arriving between render and click stay unread rather than being swallowed
  // by a button that promised to clear a specific number. The feed is
  // newest-first, so this is the first entry.
  const newestTS = timeline.events[0]?.ts

  const markRead = useMutation({
    mutationFn: () =>
      api.markResourceRead({ type: resource.type, id: resource.id, through_ts: newestTS! }),
    onSuccess: () => {
      // Three surfaces show this resource's unread state: the home cards'
      // focus lines, this worktree's resource list, and every timeline's dots
      // and divider.
      void qc.invalidateQueries({ queryKey: ["worktrees"] })
      void qc.invalidateQueries({ queryKey: ["resources", path] })
      void qc.invalidateQueries({ queryKey: ["timeline"] })
    },
  })

  return (
    <>
      <ResourceCard
        r={resource}
        path={path}
        onRemoved={onRemoved}
        onMetaChanged={onResourceChanged}
        variant="detail"
      />
      <Group justify="space-between" align="center">
        <Title order={5}>Activity</Title>
        {unreadCount > 0 && (
          <Button
            size="compact-xs"
            variant="subtle"
            loading={markRead.isPending}
            disabled={!newestTS}
            onClick={() => markRead.mutate()}
          >
            {`Mark ${unreadCount} ${unreadCount === 1 ? "event" : "events"} as read`}
          </Button>
        )}
      </Group>
      <TimelineFeed
        events={timeline.events}
        loading={timeline.isLoading}
        error={timeline.error}
        hasMore={timeline.hasMore}
        onLoadMore={timeline.loadMore}
        loadingMore={timeline.loadingMore}
        showUnreadDivider
      />
      {/*
        The feed only holds what the poller captured for this worktree, which
        is never the resource's whole history. This is the way out to the rest
        of it, at the point where the reader has run out of events.
      */}
      {resource.url && serviceName(resource.type) && (
        <Center>
          <Button
            size="xs"
            variant="subtle"
            component="a"
            href={resource.url}
            target="_blank"
            rel="noreferrer"
          >
            More activity on {serviceName(resource.type)}
          </Button>
        </Center>
      )}
    </>
  )
}

/**
 * The selected-resource pane. This is the swappable slot the design called
 * for: the surrounding shell (back control, responsive placement, selection
 * state) is identical for every resource type, and only the body differs —
 * a Slack thread renders in place of the filtered activity feed.
 */
export function ResourceDetailPane({
  path,
  resource,
  onBack,
  onRemoved,
  onResourceChanged,
}: ResourceDetailPaneProps) {
  return (
    <Stack gap="sm">
      {onBack && (
        // Styled as a link to match "← all worktrees", but a <button>
        // underneath: it deselects rather than navigating somewhere new.
        <Anchor component="button" type="button" size="sm" onClick={onBack} style={{ alignSelf: "flex-start" }}>
          ← all resources
        </Anchor>
      )}
      {resource.type === "slack" ? (
        <SlackThreadPane
          resource={resource}
          path={path}
          onRemoved={onRemoved}
          onResourceChanged={onResourceChanged}
        />
      ) : (
        <TimelineBody
          path={path}
          resource={resource}
          onRemoved={onRemoved}
          onResourceChanged={onResourceChanged}
        />
      )}
    </Stack>
  )
}
