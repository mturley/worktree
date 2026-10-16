import { useMemo, useState } from "react"
import { useLocation } from "wouter"
import { serializeResourceKey } from "../lib/resourceKey"
import { isArchivedEvent, openEventState } from "../lib/openEvent"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { Badge, Box, Button, Grid, Group, Stack, Tabs } from "@mantine/core"
import { useElementSize } from "@mantine/hooks"
import { IconPlus } from "@tabler/icons-react"
import { useWorktrees } from "../hooks/useWorktrees"
import { useGlobalTimeline } from "../hooks/useTimeline"
import { useIsWide } from "../hooks/useIsWide"
import { useIsTall } from "../hooks/useIsTall"
import { pinnedStyle } from "../lib/stickyList"
import { WorktreeList } from "../components/WorktreeList"
import { TimelineFeed } from "../components/TimelineFeed"
import { ArchivedToggle } from "../components/ArchivedToggle"
import { useUnreadOnly } from "../hooks/useUnreadOnly"
import { SourceFilter } from "../components/SourceFilter"
import { EventTypeFilter } from "../components/EventTypeFilter"
import { useActivityFilter } from "../hooks/useActivityFilter"
import { RefreshWatchersButton } from "../components/RefreshWatchersButton"
import { WatcherLogButton } from "../components/WatcherLogButton"
import { NewWorktreeModal } from "../components/NewWorktreeModal"
import { SearchSummary } from "../components/search/SearchSummary"
import { useSeeEverything } from "../hooks/useSeeEverything"
import { ClearFiltersLink } from "../components/search/ClearFiltersLink"
import { HomeHeader } from "../components/HomeHeader"
import { EventDetailsModal } from "../components/EventDetailsModal"
import { SearchBar } from "../components/search/SearchBar"
import { SearchContext } from "../components/search/SearchContext"
import { buildSuggestions } from "../components/search/suggestions"
import { useSearchQuery } from "../hooks/useSearchQuery"
import { useAllResources } from "../hooks/useAllResources"
import { matchWorktree } from "../lib/search"
import { useCmux } from "../api/cmux"
import { useWorktreeSort } from "../hooks/useWorktreeSort"
import { WorktreeSortControl } from "../components/WorktreeSortControl"
import { cmuxPositions, sortWorktrees } from "../lib/worktreeSort"
import { filterWorktreeBySources, matchesSources } from "../lib/sourceFilter"
import { ResourcesPanel, ResourcesTabControls } from "../components/ResourcesPanel"
import { useResourcesView } from "../hooks/useResourcesView"

type RightTab = "timeline" | "resources"

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
  const search = useSearchQuery()
  // The one spelling of the query every empty state quotes.
  const queryText = search.q.trim()
  const resourcesView = useResourcesView(unreadOnly, search.terms)
  // The same cached query the Resources tab uses.
  const allResources = useAllResources()
  // An archived event has no worktree to route to; picking one in the search
  // dropdown opens its details here instead.
  const [pickedEvent, setPickedEvent] = useState<TimelineEvent | null>(null)
  // Wide: the header sits above the columns, which shrink by its height.
  const { ref: headerRef, height: headerH } = useElementSize()
  // Each column is its own scroller. The page is the header (measured as its
  // border box, so its own md top padding is already in headerH) plus the
  // Grid: its sm top and md bottom padding, around a row whose -md/2
  // margins cancel the columns' md/2 padding, leaving the row exactly a
  // column's height H. Page = headerH + sm + H - md + md = 100dvh, so
  // H = 100dvh - headerH - sm, and the page itself does not scroll (unless a
  // banner above it adds its own height).
  const columnStyle = {
    height: `calc(100dvh - ${headerH}px - var(--mantine-spacing-sm))`,
    overflowY: "auto",
  } as const
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
  const tl = useGlobalTimeline(archived, sources, unreadOnly, eventTypes, search.debouncedQ)
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

  // Every resource each worktree follows, related included, for "via"
  // matches. Falls back to the card's focus resources until it loads.
  const resourcesByPath = useMemo(() => {
    const m = new Map<string, ResourceDTO[]>()
    for (const r of allResources.data ?? []) {
      if (!matchesSources(r.type, sources)) continue
      for (const w of r.worktrees) m.set(w.path, [...(m.get(w.path) ?? []), r])
    }
    return m
  }, [allResources.data, sources])

  const searchContext = useMemo(() => ({ terms: search.terms, resourcesByPath }), [search.terms, resourcesByPath])

  // The Activity source toggles narrow the cards too: each card keeps only
  // resources of that source, and a card with none of them drops out. Then
  // the search narrows what is left to the worktrees that match it.
  const shownWorktrees = useMemo(
    () =>
      (unreadOnly ? sortedWorktrees.filter((w) => w.has_unread) : sortedWorktrees)
        .map((w) => filterWorktreeBySources(w, sources))
        .filter((w): w is NonNullable<typeof w> => w !== null)
        .filter((w) => search.terms.length === 0 || matchWorktree(
          w, (cmux.data?.available ? cmux.data.matches?.[w.path] ?? [] : []).map((m) => m.title),
          resourcesByPath.get(w.path) ?? w.focus_resources, search.terms,
        ) !== null),
    [sortedWorktrees, unreadOnly, sources, search.terms, resourcesByPath, cmux.data],
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
    <Group justify="space-between" gap="xs" data-testid="worktrees-toolbar">
      {sortControl}
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

  const everything = useSeeEverything()
  // Unreads only narrows every pane here, so their match lines say so.
  const withUnread = unreadOnly ? "with unread events" : undefined
  const eventNoun: [string, string] = unreadOnly ? ["unread event", "unread events"] : ["event", "events"]
  // A search or Unreads only narrows the panes: each then heads its results
  // with a line saying how many are left, and the way back (SearchSummary).
  const narrowed = search.terms.length > 0 || unreadOnly
  const worktrees = (
    <Stack gap="xs">
      {narrowed && (
        <SearchSummary count={shownWorktrees.length} noun={["worktree", "worktrees"]} qualifier={withUnread} />
      )}
      <WorktreeList
      items={shownWorktrees}
      // Only once there are worktrees to hide: with none at all, the usual
      // "create one" hint is the more useful thing to say.
      emptyText={
        sortedWorktrees.length === 0
          ? undefined
          : search.terms.length > 0
            // The "0 worktrees match your search" line above says it.
            ? null
            : sources.length > 0
            ? `No worktrees${unreadOnly ? " with unread events" : ""} following that source`
            : unreadOnly
              // The "0 worktrees with unread events" line above says it.
              ? null
              : undefined
      }
      />
    </Stack>
  )
  const resourcesSummary = narrowed && (
    <SearchSummary count={resourcesView.shown.length} noun={["resource", "resources"]} qualifier={withUnread} />
  )
  // The Activity tab's own controls: refresh, the watcher log and archived.
  const activityControls = (
    <Group gap="sm" wrap="nowrap" align="center" data-testid="activity-controls">
      <Group gap={6} wrap="nowrap" align="center">
        <RefreshWatchersButton />
        <WatcherLogButton scope={{}} />
      </Group>
      <ArchivedToggle value={archived} onChange={setArchived} />
    </Group>
  )

  // While searching, each tab shows how many results it holds ("N+" when
  // the feed has more pages).
  const counting = search.terms.length > 0
  const countBadge = (n: number, more = false) =>
    counting ? <Badge size="xs" variant="light" ml={6}>{more ? `${n}+` : n}</Badge> : null

  // Wide, the right column's tab bar. As on the worktree page's resource
  // tabs, the active tab's controls sit at the bar's far end. It rides at
  // the top of whichever tab's pinned header is showing, so it stays in
  // reach as the column scrolls.
  const rightTabBar = (
    <Tabs value={rightTab} onChange={(v) => v && setRightTab(v as RightTab)}>
      <Tabs.List>
        <Tabs.Tab value="timeline">Activity{countBadge(tl.events.length, tl.hasMore)}</Tabs.Tab>
        <Tabs.Tab value="resources">Resources{countBadge(resourcesView.shown.length)}</Tabs.Tab>
        <Group ml="auto" align="center" gap="md" wrap="nowrap" pb={4}>
          {rightTab === "timeline" ? activityControls : <ResourcesTabControls view={resourcesView} />}
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
        {/* Wide, the tab bar, which carries this tab's controls; narrow,
            where the tab bar has no room for them, the controls alone. */}
        {top ?? activityControls}
        <Group>
          <SourceFilter value={sources} onChange={setSources} />
        </Group>
        {/* Narrows only the feed, not the worktree cards: a card follows
            resources, and every resource has every kind of event. */}
        <EventTypeFilter sources={sources} value={categories} onChange={setCategories} />
        {/* Clearing the sources clears the event types with them (see
            useActivityFilter). Archived, unreads only and the search are
            separate switches, each with its own way off. */}
        <ClearFiltersLink active={sources.length > 0 || categories.length > 0} onClear={() => setSources([])} />
        {/* Directly above the results it counts. Only once the feed holds
            the results for what is typed: during the debounce and the first
            fetch it would count the old ones. */}
        {narrowed && search.debouncedQ === queryText && !tl.isLoading && (
          <SearchSummary count={tl.events.length} more={tl.hasMore} noun={eventNoun} />
        )}
      </Stack>
      <TimelineFeed
        events={tl.events}
        loading={tl.isLoading}
        error={tl.error}
        showWorktrees
        // Searching or unread only, the "0 … events" line above says it.
        emptyText={narrowed ? null : undefined}
        hasMore={tl.hasMore}
        onLoadMore={tl.loadMore}
        loadingMore={tl.loadingMore}
        onSelectResource={selectResourceInFirstWorktree}
        canSelectResource={(e) => Boolean(e.worktree_paths?.length)}
      />
    </Stack>
  )

  const suggestions = buildSuggestions({
    terms: search.terms,
    worktrees: shownWorktrees.map((w) => ({
      w, workspaceTitles: (cmux.data?.available ? cmux.data.matches?.[w.path] ?? [] : []).map((m) => m.title),
      resources: resourcesByPath.get(w.path) ?? w.focus_resources,
    })),
    resources: resourcesView.shown.map((r) => ({ r, worktreePath: r.worktrees[0]?.path })),
    events: tl.events,
    go: {
      worktree: (p) => navigate(`/worktree/${encodeURIComponent(p)}`),
      resource: (r, p) => p && navigate(`/worktree/${encodeURIComponent(p)}?resource=${serializeResourceKey(r)}`),
      // An archived event (only with "Show archived" on) has no worktree to
      // route to; like its row, it opens the details modal, which offers to
      // follow the resource again.
      event: (e) => (isArchivedEvent(e) || !e.worktree_paths?.length
        ? setPickedEvent(e)
        : selectResourceInFirstWorktree({ type: e.resource_type, id: e.resource_id }, e)),
    },
  })
  // Esc sees everything: clears the search and turns Unreads only off.
  const searchBar = (
    <SearchBar
      value={search.q}
      onChange={search.setQ}
      suggestions={suggestions}
      onEscape={everything.seeEverything}
      escapeActive={everything.active}
    />
  )
  const header = <HomeHeader search={searchBar} unreadOnly={unreadOnly} onUnreadOnlyChange={setUnreadOnly} />
  const detailsModal = <EventDetailsModal e={pickedEvent} onClose={() => setPickedEvent(null)} />

  // Narrow: the two panes would otherwise stack, pushing the worktree list
  // far off-screen, so offer them as tabs instead.
  if (!wide) {
    return (
      <SearchContext.Provider value={searchContext}>
        <Stack p="md" gap="sm">
          <NewWorktreeModal opened={newOpen} onClose={() => setNewOpen(false)} />
          {detailsModal}
          {header}
          <Tabs defaultValue="worktrees">
            <Tabs.List>
              <Tabs.Tab value="worktrees">Worktrees{countBadge(shownWorktrees.length)}</Tabs.Tab>
              <Tabs.Tab value="timeline">Activity{countBadge(tl.events.length, tl.hasMore)}</Tabs.Tab>
              <Tabs.Tab value="resources">Resources{countBadge(resourcesView.shown.length)}</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="worktrees" pt="md">
              <Stack gap="xs">
                {listToolbar}
                {worktrees}
              </Stack>
            </Tabs.Panel>
            <Tabs.Panel value="timeline" pt="md">{timeline()}</Tabs.Panel>
            <Tabs.Panel value="resources" pt="md">
              <ResourcesPanel
                view={resourcesView}
                top={<ResourcesTabControls view={resourcesView} />}
                searchSummary={resourcesSummary}
              />
            </Tabs.Panel>
          </Tabs>
        </Stack>
      </SearchContext.Provider>
    )
  }

  return (
    // The header sits above the columns. Even split below it. The worktree
    // cards carry more per row than they used to — a cmux workspace header,
    // two meta lines, focus resources — so the narrower column was wrapping
    // content that the timeline had width to spare for.
    //
    // Each column is its own scroller, sized to what is left under the
    // header (see columnStyle), so the page itself does not scroll (unless a
    // banner above it adds its own height). No overflow on the Grid itself —
    // its row's negative margins would show as a sideways scrollbar.
    <SearchContext.Provider value={searchContext}>
      <Box px="md" pt="md" ref={headerRef}>{header}</Box>
      <Grid px="md" pb="md" pt="sm" gutter="md">
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
            : <ResourcesPanel view={resourcesView} headerStyle={headerStyle} top={rightTabBar} searchSummary={resourcesSummary} />}
        </Grid.Col>
        <NewWorktreeModal opened={newOpen} onClose={() => setNewOpen(false)} />
        {detailsModal}
      </Grid>
    </SearchContext.Provider>
  )
}
