import { useState } from "react"
import { useLocation } from "wouter"
import { serializeResourceKey } from "../lib/resourceKey"
import { Button, Grid, Group, Stack, Tabs, Title } from "@mantine/core"
import { IconPlus } from "@tabler/icons-react"
import { useWorktrees } from "../hooks/useWorktrees"
import { useGlobalTimeline } from "../hooks/useTimeline"
import { useIsWide } from "../hooks/useIsWide"
import { WorktreeList } from "../components/WorktreeList"
import { TimelineFeed } from "../components/TimelineFeed"
import { ArchivedToggle } from "../components/ArchivedToggle"
import { SourceFilter } from "../components/SourceFilter"
import { NewWorktreeModal } from "../components/NewWorktreeModal"

export function HomePage() {
  const [, navigate] = useLocation()
  const [archived, setArchived] = useState(false)
  const [sources, setSources] = useState<string[]>([])
  const [newOpen, setNewOpen] = useState(false)
  const wide = useIsWide()
  const wts = useWorktrees()
  const tl = useGlobalTimeline(archived, sources)

  const newWorktreeButton = (
    <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setNewOpen(true)}>
      New worktree
    </Button>
  )

  /**
   * Opens a resource from the global timeline.
   *
   * A resource has no meaning without a worktree here — the feed spans all of
   * them — so this routes to the FIRST worktree following it, which the event
   * already names in worktree_paths. Chips are only rendered for events that
   * have one, so there is always a destination.
   */
  const selectResourceInFirstWorktree = (key: { type: string; id: string }) => {
    const hit = tl.events.find(
      (e) => e.resource_type === key.type && e.resource_id === key.id && e.worktree_paths?.length,
    )
    const path = hit?.worktree_paths?.[0]
    if (!path) return
    navigate(`/worktree/${encodeURIComponent(path)}?resource=${serializeResourceKey(key)}`)
  }

  const worktrees = <WorktreeList items={wts.data ?? []} />
  const timeline = (
    <Stack gap="sm">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Title order={4}>Timeline</Title>
        {/* Both controls narrow the same feed, so they sit together on the
            right — matching the worktree page, where the filter is opposite
            the heading. */}
        <Group gap="sm" wrap="wrap">
          <SourceFilter value={sources} onChange={setSources} />
          <ArchivedToggle value={archived} onChange={setArchived} />
        </Group>
      </Group>
      <TimelineFeed
        events={tl.events}
        loading={tl.isLoading}
        error={tl.error}
        showWorktrees
        hasMore={tl.hasMore}
        onLoadMore={tl.loadMore}
        loadingMore={tl.loadingMore}
        onSelectWorktree={(path) => navigate(`/worktree/${encodeURIComponent(path)}`)}
        onSelectResource={selectResourceInFirstWorktree}
        canSelectResource={(e) => Boolean(e.worktree_paths?.length)}
      />
    </Stack>
  )

  // Narrow: the two panes would otherwise stack, pushing the worktree list
  // far off-screen, so offer them as tabs instead.
  if (!wide) {
    return (
      <Stack p="md" gap="sm">
        <Group justify="flex-end">{newWorktreeButton}</Group>
        <NewWorktreeModal opened={newOpen} onClose={() => setNewOpen(false)} />
        <Tabs defaultValue="worktrees">
          <Tabs.List>
            <Tabs.Tab value="worktrees">Worktrees</Tabs.Tab>
            <Tabs.Tab value="timeline">Timeline</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="worktrees" pt="md">{worktrees}</Tabs.Panel>
          <Tabs.Panel value="timeline" pt="md">{timeline}</Tabs.Panel>
        </Tabs>
      </Stack>
    )
  }

  return (
    // Even split. The worktree cards carry more per row than they used to —
    // a cmux workspace header, two meta lines, focus resources — so the
    // narrower column was wrapping content that the timeline had width to
    // spare for.
    <Grid p="md" gutter="md">
      <Grid.Col span={6}>
        <Stack gap="sm">
          <Group justify="space-between">
            <Title order={4}>Worktrees</Title>
            {newWorktreeButton}
          </Group>
          {worktrees}
        </Stack>
      </Grid.Col>
      <Grid.Col span={6}>{timeline}</Grid.Col>
      <NewWorktreeModal opened={newOpen} onClose={() => setNewOpen(false)} />
    </Grid>
  )
}
