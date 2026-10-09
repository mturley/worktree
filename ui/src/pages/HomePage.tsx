import { useMemo, useState } from "react"
import { useLocation } from "wouter"
import { serializeResourceKey } from "../lib/resourceKey"
import { openEventState } from "../lib/openEvent"
import type { TimelineEvent } from "../api/types"
import { Button, Grid, Group, Stack, Tabs, Title } from "@mantine/core"
import { IconPlus } from "@tabler/icons-react"
import { useWorktrees } from "../hooks/useWorktrees"
import { useGlobalTimeline } from "../hooks/useTimeline"
import { useIsWide } from "../hooks/useIsWide"
import { WorktreeList } from "../components/WorktreeList"
import { TimelineFeed } from "../components/TimelineFeed"
import { ArchivedToggle } from "../components/ArchivedToggle"
import { UnreadOnlyToggle } from "../components/UnreadOnlyToggle"
import { useUnreadOnly } from "../hooks/useUnreadOnly"
import { SourceFilter } from "../components/SourceFilter"
import { RefreshWatchersButton } from "../components/RefreshWatchersButton"
import { NewWorktreeModal } from "../components/NewWorktreeModal"
import { DevicesButton } from "../components/DevicesButton"
import { FollowCmuxToggle } from "../components/FollowCmuxToggle"
import { Logo } from "../components/Logo"
import { useCmux } from "../api/cmux"
import { useWorktreeSort } from "../hooks/useWorktreeSort"
import { WorktreeSortControl } from "../components/WorktreeSortControl"
import { cmuxPositions, sortWorktrees } from "../lib/worktreeSort"
import { filterWorktreeBySources } from "../lib/sourceFilter"

export function HomePage() {
  const [, navigate] = useLocation()
  const [archived, setArchived] = useState(false)
  const [sources, setSources] = useState<string[]>([])
  // Shared with every worktree page and every other tab; narrows both the
  // worktree list and the activity feed.
  const [unreadOnly, setUnreadOnly] = useUnreadOnly()
  const [newOpen, setNewOpen] = useState(false)
  const wide = useIsWide()
  const wts = useWorktrees()
  const tl = useGlobalTimeline(archived, sources, unreadOnly)
  const sort = useWorktreeSort()
  // Same shared query the cards use, so this costs no extra request.
  const cmux = useCmux()
  const positions = useMemo(() => cmuxPositions(cmux.data?.matches), [cmux.data])
  // Undecided (null) leaves the server's order in place rather than showing
  // one order and jumping to another when the cmux answer lands.
  const sortedWorktrees = useMemo(() => {
    const items = wts.data ?? []
    if (sort.mode === null) return items
    return sortWorktrees(items, {
      mode: sort.mode, createdDir: sort.createdDir, nameDir: sort.nameDir, cmuxPositions: positions,
    })
  }, [wts.data, sort.mode, sort.createdDir, sort.nameDir, positions])

  // The Activity source toggles narrow the cards too: each card keeps only
  // resources of that source, and a card with none of them drops out.
  const shownWorktrees = useMemo(
    () =>
      (unreadOnly ? sortedWorktrees.filter((w) => w.has_unread) : sortedWorktrees)
        .map((w) => filterWorktreeBySources(w, sources))
        .filter((w): w is NonNullable<typeof w> => w !== null),
    [sortedWorktrees, unreadOnly, sources],
  )

  const sortControl = (
    <WorktreeSortControl
      mode={sort.mode}
      direction={sort.mode === "name" ? sort.nameDir : sort.createdDir}
      cmuxAvailable={sort.cmuxAvailable}
      onModeChange={sort.setMode}
      onDirectionChange={sort.mode === "name" ? sort.setNameDir : sort.setCreatedDir}
    />
  )
  const newWorktreeButton = (
    <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setNewOpen(true)}>
      New worktree
    </Button>
  )

  // Above the worktree list on wide, inside the Worktrees tab on narrow.
  const listToolbar = (
    <Group justify="space-between" gap="xs">
      <Group gap="lg">
        {/* The logo stands in for the old "Worktrees" title, and keeps its
            name as the heading's accessible text. */}
        <Title order={4}><Logo alt="Worktrees" /></Title>
        {sortControl}
        <FollowCmuxToggle />
        {/* With the worktree list, which it narrows first; it narrows the
            activity feed too. */}
        <UnreadOnlyToggle value={unreadOnly} onChange={setUnreadOnly} />
      </Group>
      <Group gap="xs" wrap="nowrap">
        {newWorktreeButton}
        <DevicesButton />
      </Group>
    </Group>
  )

  /**
   * Opens an event's resource from the global timeline, then its details.
   *
   * A resource has no meaning without a worktree here — the feed spans all of
   * them — so this routes to the FIRST worktree following it, which the event
   * names in worktree_paths. Rows are only clickable this way for events that
   * have one (canSelectResource), so there is always a destination.
   *
   * The event rides along in history state, and the worktree page opens its
   * details modal over the selected resource: clicking an entry is asking
   * about THAT entry, and landing on the resource alone left you to find it
   * again in the resource's feed.
   */
  const selectResourceInFirstWorktree = (key: { type: string; id: string }, e: TimelineEvent) => {
    const path = e.worktree_paths?.[0]
    if (!path) return
    navigate(`/worktree/${encodeURIComponent(path)}?resource=${serializeResourceKey(key)}`, {
      state: openEventState(e),
    })
  }

  const worktrees = (
    <WorktreeList
      items={shownWorktrees}
      // Only once there are worktrees to hide: with none at all, the usual
      // "create one" hint is the more useful thing to say.
      emptyText={
        sortedWorktrees.length === 0
          ? undefined
          : sources.length > 0
            ? `No worktrees${unreadOnly ? " with unread events" : ""} following that source`
            : unreadOnly
              ? "No worktrees with unread events"
              : undefined
      }
    />
  )
  const timeline = (
    <Stack gap="sm">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap={6} wrap="nowrap" align="center">
          <Title order={4}>Activity</Title>
          <RefreshWatchersButton />
        </Group>
        {/* The source filter (which also narrows the worktree cards) gets a
            line of its own below. */}
        <ArchivedToggle value={archived} onChange={setArchived} />
      </Group>
      <Group>
        <SourceFilter value={sources} onChange={setSources} />
      </Group>
      <TimelineFeed
        events={tl.events}
        loading={tl.isLoading}
        error={tl.error}
        showWorktrees
        emptyText={unreadOnly ? "No unread events." : undefined}
        hasMore={tl.hasMore}
        onLoadMore={tl.loadMore}
        loadingMore={tl.loadingMore}
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
        <NewWorktreeModal opened={newOpen} onClose={() => setNewOpen(false)} />
        <Tabs defaultValue="worktrees">
          <Tabs.List>
            <Tabs.Tab value="worktrees">Worktrees</Tabs.Tab>
            <Tabs.Tab value="timeline">Activity</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="worktrees" pt="md">
            <Stack gap="xs">
              {listToolbar}
              {worktrees}
            </Stack>
          </Tabs.Panel>
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
          {listToolbar}
          {worktrees}
        </Stack>
      </Grid.Col>
      <Grid.Col span={6}>{timeline}</Grid.Col>
      <NewWorktreeModal opened={newOpen} onClose={() => setNewOpen(false)} />
    </Grid>
  )
}
