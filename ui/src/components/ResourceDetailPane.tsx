import { Button, Stack, Title } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { useWorktreeTimeline } from "../hooks/useTimeline"
import { ResourceCard } from "./ResourceCard"
import { TimelineFeed } from "./TimelineFeed"

interface ResourceDetailPaneProps {
  path: string
  resource: ResourceDTO
  /** Supplied only on narrow viewports, where this pane is a drilldown. */
  onBack?: () => void
}

/**
 * The selected-resource pane: a fuller summary of the resource above a
 * timeline filtered to just that resource.
 *
 * This is deliberately a swappable slot. Phase B (see
 * docs/superpowers/specs/2026-08-21-worktree-ui-resource-selection-design.md)
 * adds a `resource.type === "slack"` branch here that renders the Slack
 * thread in place of the filtered timeline — the surrounding responsive
 * shell, selection state, and back control stay exactly as they are.
 */
export function ResourceDetailPane({ path, resource, onBack }: ResourceDetailPaneProps) {
  const timeline = useWorktreeTimeline(path, { type: resource.type, id: resource.id })

  return (
    <Stack gap="sm">
      {onBack && (
        <Button variant="subtle" size="compact-sm" onClick={onBack} style={{ alignSelf: "flex-start" }}>
          ← all resources for worktree
        </Button>
      )}
      <ResourceCard r={resource} variant="detail" />
      <Title order={5}>Activity</Title>
      <TimelineFeed
        events={timeline.data?.events ?? []}
        loading={timeline.isLoading}
        error={timeline.error}
      />
    </Stack>
  )
}
