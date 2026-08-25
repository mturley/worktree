import { Button, Stack, Title } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { useWorktreeTimeline } from "../hooks/useTimeline"
import { ResourceCard } from "./ResourceCard"
import { SlackThreadPane } from "./SlackThreadPane"
import { TimelineFeed } from "./TimelineFeed"

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
        <Button variant="subtle" size="compact-sm" onClick={onBack} style={{ alignSelf: "flex-start" }}>
          ← all resources for worktree
        </Button>
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
