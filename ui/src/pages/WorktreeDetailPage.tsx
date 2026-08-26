import { useEffect, useState } from "react"
import { Anchor, Grid, Group, Stack, Title } from "@mantine/core"
import { Link, useRoute } from "wouter"
import { useWorktreeDetail } from "../hooks/useWorktreeDetail"
import { useSelectedResource } from "../hooks/useSelectedResource"
import { useIsWide } from "../hooks/useIsWide"
import { useWorktrees } from "../hooks/useWorktrees"
import { ResourceList } from "../components/ResourceList"
import { ResourceDetailPane } from "../components/ResourceDetailPane"
import { TimelineFeed } from "../components/TimelineFeed"
import { WorktreeDetailCard } from "../components/WorktreeDetailCard"
import { ThreadActionsContext } from "../components/slack/ThreadActionsContext"
import { AddResourceModal } from "../components/AddResourceModal"
import { parseThreadUrl } from "../lib/parseThreadUrl"

export function WorktreeDetailPage() {
  const [, params] = useRoute("/worktree/:path*")
  const rawPath = params?.["path*"]
  const path = rawPath ? decodeURIComponent(rawPath) : ""
  const { resources, timeline } = useWorktreeDetail(path)
  const { selected, select, toggle, clear } = useSelectedResource()
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

  // Thread-unfurl actions live here because this is the only place that knows
  // BOTH the worktree's resource list (is this thread already tracked?) and
  // the selection state (show it). Deriving "tracked" from the list rather
  // than from what was just added keeps the unfurl button correct across
  // navigation and for threads added elsewhere.
  // URL of a thread the user asked to add from a Slack unfurl; non-null while
  // the pre-filled add modal is open.
  const [pendingThreadUrl, setPendingThreadUrl] = useState<string | null>(null)

  const threadActions = {
    // Opens the add-resource modal pre-filled rather than adding outright,
    // so Focus/Related and the optional name/description are chosen at add
    // time instead of being defaulted and corrected afterwards.
    requestAddThread: (url: string) => setPendingThreadUrl(url),
    trackedThread: (url: string) => {
      const parsed = parseThreadUrl(url)
      if (!parsed) return null
      const id = `${parsed.channel}:${parsed.threadTs}`
      const hit = items.find((r) => r.type === "slack" && r.id === id)
      return hit ? { type: hit.type, id: hit.id } : null
    },
    selectThread: (key: { type: string; id: string }) => select(key),
  }

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
      <TimelineFeed
        events={timeline.events}
        loading={timeline.isLoading}
        error={timeline.error}
        hasMore={timeline.hasMore}
        onLoadMore={timeline.loadMore}
        loadingMore={timeline.loadingMore}
        // Only meaningful here: this page has a selection to change, and the
        // worktree's own resource list to resolve icons and titles against.
        onSelectResource={select}
        resolveResource={(type, id) => items.find((r) => r.type === type && r.id === id)}
      />
    </Stack>
  )

  // Narrow + a selection drills down to the resource, replacing the list.
  // Wide shows both. Both read the same selection state, so resizing swaps
  // presentation without disturbing what is selected.
  const overview = !wide ? (
    selectedResource ? (
      <ResourceDetailPane
        path={path}
        resource={selectedResource}
        onBack={clear}
        onRemoved={resources.refetch}
        onResourceChanged={resources.refetch}
      />
    ) : (
      list
    )
  ) : (
    <Grid gutter="md">
      <Grid.Col span={4}>{list}</Grid.Col>
      <Grid.Col span={8}>
        {selectedResource ? (
          <ResourceDetailPane
            path={path}
            resource={selectedResource}
            onRemoved={resources.refetch}
            onResourceChanged={resources.refetch}
          />
        ) : (
          unfiltered
        )}
      </Grid.Col>
    </Grid>
  )

  return (
    <ThreadActionsContext.Provider value={threadActions}>
    <Stack p="md" gap="md">
      <Group>
        <Anchor component={Link} href="/">← all worktrees</Anchor>
        <Title order={4}>{branch}</Title>
      </Group>
      {summary && <WorktreeDetailCard w={summary} />}
      {/*
        No Overview/Slack tabs: a Slack thread is selected like any other
        resource and renders in ResourceDetailPane, so the resource list plus
        that pane is the whole page body.
      */}
      {overview}
      {pendingThreadUrl !== null && (
        // Keyed by URL so the modal remounts per thread: it seeds its fields
        // from initialUrl at mount, and a stale instance would show the
        // previous thread's URL.
        <AddResourceModal
          key={pendingThreadUrl}
          opened
          path={path}
          initialUrl={pendingThreadUrl}
          onClose={() => setPendingThreadUrl(null)}
          onAdded={() => {
            setPendingThreadUrl(null)
            void resources.refetch()
          }}
        />
      )}
    </Stack>
    </ThreadActionsContext.Provider>
  )
}
