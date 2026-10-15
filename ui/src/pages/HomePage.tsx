import { useMemo, useState } from "react"
import { useLocation } from "wouter"
import { serializeResourceKey } from "../lib/resourceKey"
import { openEventState } from "../lib/openEvent"
import type { TimelineEvent } from "../api/types"
import { Box, Button, Grid, Group, Stack, Tabs, Title } from "@mantine/core"
import { IconPlus } from "@tabler/icons-react"
import { useWorktrees } from "../hooks/useWorktrees"
import { useGlobalTimeline } from "../hooks/useTimeline"
import { useIsWide } from "../hooks/useIsWide"
import { useIsTall } from "../hooks/useIsTall"
import { pinnedStyle } from "../lib/stickyList"
import { WorktreeList } from "../components/WorktreeList"
import { TimelineFeed } from "../components/TimelineFeed"
import { ArchivedToggle } from "../components/ArchivedToggle"
import { UnreadOnlyToggle } from "../components/UnreadOnlyToggle"
import { useUnreadOnly } from "../hooks/useUnreadOnly"
import { SourceFilter } from "../components/SourceFilter"
import { EventTypeFilter } from "../components/EventTypeFilter"
import { useActivityFilter } from "../hooks/useActivityFilter"
import { RefreshWatchersButton } from "../components/RefreshWatchersButton"
import { WatcherLogButton } from "../components/WatcherLogButton"
import { NewWorktreeModal } from "../components/NewWorktreeModal"
import { SettingsButton } from "../components/SettingsButton"
import { FollowCmuxToggle } from "../components/FollowCmuxToggle"
import { Logo } from "../components/Logo"
import { useCmux } from "../api/cmux"
import { useWorktreeSort } from "../hooks/useWorktreeSort"
import { WorktreeSortControl } from "../components/WorktreeSortControl"
import { cmuxPositions, sortWorktrees } from "../lib/worktreeSort"
import { filterWorktreeBySources } from "../lib/sourceFilter"
import { ResourcesPanel } from "../components/ResourcesPanel"

type RightTab = "timeline" | "resources"

const columnStyle = { height: "calc(100dvh - var(--mantine-spacing-md))", overflowY: "auto" } as const

export function HomePage() {
  const [, navigate] = useLocation()
  const [archived, setArchived] = useState(false)
  const { sources, setSources, categories, setCategories, eventTypes } = useActivityFilter()
  // Shared with every worktree page and every other tab; narrows both the
  // worktree list and the activity feed.
  const [unreadOnly, setUnreadOnly] = useUnreadOnly()
  const [newOpen, setNewOpen] = useState(false)
  // Wide only: which of Activity and Resources fills the right column.
  const [rightTab, setRightTab] = useState<RightTab>("timeline")
  const wide = useIsWide()
  const tall = useIsTall()
  // Wide, each column scrolls on its own, and its header (with the activity
  // filters) stays pinned at the top of it — with room to spare only, as on
  // the worktree page. Inside a scrolling column, so the pin is measured
  // inside its padding: see pinnedStyle.
  const headerStyle = wide && tall
    ? pinnedStyle("calc(-1 * var(--grid-col-padding))", "var(--grid-col-padding)")
    : undefined
  const wts = useWorktrees()
  const tl = useGlobalTimeline(archived, sources, unreadOnly, eventTypes)
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
        {/* With the worktree list, which it narrows first; it narrows the
            activity feed too. */}
        <UnreadOnlyToggle value={unreadOnly} onChange={setUnreadOnly} />
        <FollowCmuxToggle />
      </Group>
      {newWorktreeButton}
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
  // Wide, the right column's tab bar, with the Settings cog at its far end
  // (top-right of the page). It rides at the top of whichever tab's pinned
  // header is showing, so it stays in reach as the column scrolls.
  const rightTabBar = (
    <Tabs value={rightTab} onChange={(v) => v && setRightTab(v as RightTab)}>
      <Tabs.List>
        <Tabs.Tab value="timeline">Activity</Tabs.Tab>
        <Tabs.Tab value="resources">Resources</Tabs.Tab>
        <Group ml="auto" align="center" pb={4}>
          <SettingsButton />
        </Group>
      </Tabs.List>
    </Tabs>
  )

  const timeline = (top?: React.ReactNode) => (
    // No gap below the header when pinned: its own padding is that space.
    <Stack gap={headerStyle ? 0 : "sm"}>
      {/* Opaque room below the filters when pinned, so the feed passing
          under them does not run right up against the buttons. */}
      <Stack
        gap="sm"
        style={headerStyle && { ...headerStyle, paddingBottom: "var(--mantine-spacing-xs)" }}
        data-activity-header
        data-tooltip-layer={headerStyle ? "pinned" : undefined}
      >
        {top}
        <Group justify="space-between" wrap="wrap" gap="xs" data-testid="activity-header">
          {/* No "Activity" title: the tab above it says so. */}
          <Group gap={6} wrap="nowrap" align="center">
            <RefreshWatchersButton />
            <WatcherLogButton scope={{}} />
          </Group>
          {/* The source filter (which also narrows the worktree cards) gets a
              line of its own below. */}
          <Group gap="sm" wrap="nowrap">
            <ArchivedToggle value={archived} onChange={setArchived} />
          </Group>
        </Group>
        <Group>
          <SourceFilter value={sources} onChange={setSources} />
        </Group>
        {/* Narrows only the feed, not the worktree cards: a card follows
            resources, and every resource has every kind of event. */}
        <EventTypeFilter sources={sources} value={categories} onChange={setCategories} />
      </Stack>
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
            <Tabs.Tab value="resources">Resources</Tabs.Tab>
            {/* Top-right of the page, whichever tab is showing. */}
            <Group ml="auto" align="center" pb={4}>
              <SettingsButton />
            </Group>
          </Tabs.List>
          <Tabs.Panel value="worktrees" pt="md">
            <Stack gap="xs">
              {listToolbar}
              {worktrees}
            </Stack>
          </Tabs.Panel>
          <Tabs.Panel value="timeline" pt="md">{timeline()}</Tabs.Panel>
          <Tabs.Panel value="resources" pt="md">
            {/* The worktree toolbar, which holds the unread-only toggle when
                wide, is on another tab here; this tab gets its own. */}
            <ResourcesPanel
              unreadOnly={unreadOnly}
              toolbarEnd={<UnreadOnlyToggle value={unreadOnly} onChange={setUnreadOnly} />}
            />
          </Tabs.Panel>
        </Tabs>
      </Stack>
    )
  }

  return (
    // Even split. The worktree cards carry more per row than they used to —
    // a cmux workspace header, two meta lines, focus resources — so the
    // narrower column was wrapping content that the timeline had width to
    // spare for.
    //
    // Each column is its own scroller, exactly the viewport's height: the
    // Grid's md padding less its row's -md/2 margins leaves the row
    // 100dvh - md tall, so the page itself does not scroll (unless a banner
    // above it adds its own height). No overflow on the Grid itself — its
    // row's negative margins would show as a sideways scrollbar.
    <Grid p="md" gutter="md">
      {/* Tooltips in both columns open under the pinned headers; see
          useTooltipLayer. */}
      <Grid.Col span={6} style={columnStyle} data-tooltip-layer="content">
        {/* As the Activity header: pinned, it carries its own opaque room
            below the toolbar in place of the gap, so the cards scrolling
            under it do not run right up against the buttons. */}
        <Stack gap={headerStyle ? 0 : "sm"}>
          <Box
            style={headerStyle && { ...headerStyle, paddingBottom: "var(--mantine-spacing-xs)" }}
            data-worktrees-header
            data-tooltip-layer={headerStyle ? "pinned" : undefined}
          >
            {listToolbar}
          </Box>
          {worktrees}
        </Stack>
      </Grid.Col>
      <Grid.Col span={6} style={columnStyle} data-tooltip-layer="content">
        {rightTab === "timeline"
          ? timeline(rightTabBar)
          : <ResourcesPanel unreadOnly={unreadOnly} headerStyle={headerStyle} top={rightTabBar} />}
      </Grid.Col>
      <NewWorktreeModal opened={newOpen} onClose={() => setNewOpen(false)} />
    </Grid>
  )
}
