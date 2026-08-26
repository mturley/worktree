import { Anchor, Button, Center, Stack, Title } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { useWorktreeTimeline } from "../hooks/useTimeline"
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
  return (
    <>
      <ResourceCard
        r={resource}
        path={path}
        onRemoved={onRemoved}
        onMetaChanged={onResourceChanged}
        variant="detail"
      />
      <Title order={5}>Activity</Title>
      <TimelineFeed
        events={timeline.events}
        loading={timeline.isLoading}
        error={timeline.error}
        hasMore={timeline.hasMore}
        onLoadMore={timeline.loadMore}
        loadingMore={timeline.loadingMore}
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
