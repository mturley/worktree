import { useEffect } from "react"
import { Anchor, Grid, Group, Stack, Title } from "@mantine/core"
import { Link, useRoute } from "wouter"
import { useWorktreeDetail } from "../hooks/useWorktreeDetail"
import { useSelectedResource } from "../hooks/useSelectedResource"
import { useIsWide } from "../hooks/useIsWide"
import { useWorktrees } from "../hooks/useWorktrees"
import { ResourceList } from "../components/ResourceList"
import { ResourceDetailPane } from "../components/ResourceDetailPane"
import { TimelineFeed } from "../components/TimelineFeed"
import { WorktreeCard } from "../components/WorktreeCard"

export function WorktreeDetailPage() {
  const [, params] = useRoute("/worktree/:path*")
  const rawPath = params?.["path*"]
  const path = rawPath ? decodeURIComponent(rawPath) : ""
  const { resources, timeline } = useWorktreeDetail(path)
  const { selected, toggle, clear } = useSelectedResource()
  const wide = useIsWide()
  const worktrees = useWorktrees()

  const items = resources.data ?? []
  const summary = (worktrees.data ?? []).find((w) => w.path === path)
  const branch = summary?.branch ?? (path.split("/").pop() || path)
  const selectedResource = selected
    ? items.find((r) => r.type === selected.type && r.id === selected.id)
    : undefined

  // A ?resource= pointing at something this worktree no longer has (removed
  // out-of-band, or a stale shared link) must not leave an empty pane. This
  // is an automatic correction of invalid input, not a deliberate deselect,
  // so it must REPLACE the history entry rather than push a new one — a push
  // here would trap the back button (stale -> clean -> back -> stale -> the
  // effect fires again and pushes clean again, forever).
  useEffect(() => {
    if (selected && resources.data && !selectedResource) clear({ replace: true })
  }, [selected, resources.data, selectedResource, clear])

  const list = (
    <ResourceList
      items={items}
      path={path}
      onChanged={resources.refetch}
      selectedKey={selected}
      onSelectResource={toggle}
    />
  )

  const unfiltered = (
    <Stack gap="sm">
      <Title order={5}>Timeline</Title>
      <TimelineFeed events={timeline.data?.events ?? []} loading={timeline.isLoading} error={timeline.error} />
    </Stack>
  )

  // Narrow + a selection drills down to the resource, replacing the list.
  // Wide shows both. Both read the same selection state, so resizing swaps
  // presentation without disturbing what is selected.
  const overview = !wide ? (
    selectedResource ? (
      <ResourceDetailPane path={path} resource={selectedResource} onBack={clear} onRemoved={resources.refetch} />
    ) : (
      list
    )
  ) : (
    <Grid gutter="md">
      <Grid.Col span={4}>{list}</Grid.Col>
      <Grid.Col span={8}>
        {selectedResource ? (
          <ResourceDetailPane path={path} resource={selectedResource} onRemoved={resources.refetch} />
        ) : (
          unfiltered
        )}
      </Grid.Col>
    </Grid>
  )

  return (
    <Stack p="md" gap="md">
      <Group>
        <Anchor component={Link} href="/">← all worktrees</Anchor>
        <Title order={4}>{branch}</Title>
      </Group>
      {summary && <WorktreeCard w={summary} clickable={false} />}
      {/*
        No Overview/Slack tabs: a Slack thread is selected like any other
        resource and renders in ResourceDetailPane, so the resource list plus
        that pane is the whole page body.
      */}
      {overview}
    </Stack>
  )
}
