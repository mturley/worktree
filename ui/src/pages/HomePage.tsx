import { useMemo, useState } from "react"
import { useLocation } from "wouter"
import { serializeResourceKey } from "../lib/resourceKey"
import type { ResourceDTO } from "../api/types"
import { Badge, Box, Button, Grid, Group, Stack, Tabs, Title } from "@mantine/core"
import { useElementSize } from "@mantine/hooks"
import { IconPlus } from "@tabler/icons-react"
import { useWorktrees } from "../hooks/useWorktrees"
import { useIsWide } from "../hooks/useIsWide"
import { useIsTall } from "../hooks/useIsTall"
import { pinnedStyle } from "../lib/stickyList"
import { WorktreeList } from "../components/WorktreeList"
import { useUnreadOnly } from "../hooks/useUnreadOnly"
import { useUnreadOnlyHotkey } from "../hooks/useUnreadOnlyHotkey"
import { usePublishEscLeaves } from "../lib/escapeHint"
import { homeWorktreeHref, useEscHome } from "../lib/homeWorktree"
import { unreadBadge } from "../lib/unreadBadge"
import { NewWorktreeModal } from "../components/NewWorktreeModal"
import { SearchSummary } from "../components/search/SearchSummary"
import { useSeeEverything } from "../hooks/useSeeEverything"
import { NarrowingContext } from "../components/search/NarrowingContext"
import { EMPTY_FILTER } from "../lib/resourceListFilter"
import { HomeHeader } from "../components/HomeHeader"
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
import { filterWorktreeByUnread } from "../lib/unreadCardFilter"
import { ResourcesPanel, ResourcesTabControls } from "../components/ResourcesPanel"
import { useResourcesView } from "../hooks/useResourcesView"
import { ChooseWorktreeModal } from "../components/ChooseWorktreeModal"
import { CrossHoverProvider } from "../components/CrossHoverContext"
import { useTasksPanel } from "../components/tasks/TasksSection"
import { useTaskModal } from "../components/tasks/modal/TaskModalProvider"
import { useActivityPanel } from "../components/ActivityPanel"

type RightTab = "timeline" | "resources"
type NarrowTab = "worktrees" | RightTab

/** Every task, with no context to link a new one to. */
const HOME_TASKS = { kind: "all" } as const

export function HomePage() {
  const [, navigate] = useLocation()
  // A task picked in the search dropdown opens its task, over this page.
  const { open: openTask } = useTaskModal()
  // Shared with every worktree page and every other tab; narrows both the
  // worktree list and the activity feed.
  const [unreadOnly, setUnreadOnly] = useUnreadOnly()
  useUnreadOnlyHotkey(unreadOnly, setUnreadOnly)
  const [newOpen, setNewOpen] = useState(false)
  // Wide only: which of Activity and Resources fills the right column.
  const [rightTab, setRightTab] = useState<RightTab>("timeline")
  // Narrow: the page's one tab bar, Worktrees first.
  const [narrowTab, setNarrowTab] = useState<NarrowTab>("worktrees")
  const search = useSearchQuery()
  // The one spelling of the query every empty state quotes.
  const queryText = search.q.trim()
  const resourcesView = useResourcesView(unreadOnly, search.terms)
  // The same cached query the Resources tab uses.
  const allResources = useAllResources()
  // The Activity feed, its controls, filters and modals; see useActivityPanel.
  const activity = useActivityPanel({
    unreadOnly,
    search: { terms: search.terms, debouncedQ: search.debouncedQ, queryText },
    select: "route",
  })
  // The Activity source toggles narrow the worktree cards too.
  const sources = activity.sources
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
  // The task panel, always above the tab bar, scrolling with the content.
  const tasks = useTasksPanel(HOME_TASKS)
  // Wide, each column scrolls on its own, and its header (with the activity
  // filters) stays pinned at the top of it — with room to spare only, as on
  // the worktree page. Inside a scrolling column, so the pin is measured
  // inside its padding: see pinnedStyle.
  const headerStyle = wide && tall
    ? pinnedStyle("calc(-1 * var(--grid-col-padding))", "var(--grid-col-padding)")
    : undefined
  const wts = useWorktrees()
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
  // Unreads only also narrows each card's list to its unread resources,
  // related ones included (filterWorktreeByUnread).
  const shownWorktrees = useMemo(
    () =>
      (unreadOnly ? sortedWorktrees.filter((w) => w.has_unread) : sortedWorktrees)
        .map((w) => filterWorktreeBySources(w, sources))
        .filter((w): w is NonNullable<typeof w> => w !== null)
        .map((w) => (unreadOnly ? filterWorktreeByUnread(w, allResources.data && (resourcesByPath.get(w.path) ?? [])) : w))
        .filter((w) => search.terms.length === 0 || matchWorktree(
          w, (cmux.data?.available ? cmux.data.matches?.[w.path] ?? [] : []).map((m) => m.title),
          resourcesByPath.get(w.path) ?? w.focus_resources, search.terms,
        ) !== null),
    [sortedWorktrees, unreadOnly, sources, search.terms, resourcesByPath, allResources.data, cmux.data],
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
    <Button size="sm" leftSection={<IconPlus size={14} />} onClick={() => setNewOpen(true)}>
      New worktree
    </Button>
  )

  // Above the worktree list on wide, inside the Worktrees tab on narrow. The
  // heading is wide only: narrow, the Worktrees tab already names the list.
  const listToolbar = (withHeading: boolean) => (
    <Group justify="space-between" gap="xs" data-testid="worktrees-toolbar">
      <Group gap="md" wrap="nowrap">
        {withHeading && <Title order={4}>Worktrees</Title>}
        {sortControl}
      </Group>
      {newWorktreeButton}
    </Group>
  )

  // A resource several worktrees follow, picked in the search dropdown, asks
  // which one (ChooseWorktreeModal), as a Resources row does. (An event's
  // chooser is useActivityPanel's.)
  const [choosing, setChoosing] = useState<{ r: ResourceDTO; worktrees: { path: string; branch: string }[] } | null>(null)
  const openResourceIn = (path: string, r: { type: string; id: string }) =>
    navigate(`/worktree/${encodeURIComponent(path)}?resource=${serializeResourceKey({ type: r.type, id: r.id })}`)

  const everything = useSeeEverything()
  // Unreads only narrows every pane here, so their match lines say so.
  const withUnread = unreadOnly ? "with unread events" : undefined
  // Which filters reach which pane: the source toggles narrow the worktree
  // cards and the feed, the event types only the feed, and the Resources
  // tab has its own.
  const sourcesOn = sources.length > 0
  const activityFiltered = activity.filtered
  const resourcesFiltered = resourcesView.filter.type !== null
  // Everything that narrows the page, and the one way back (Esc, and every
  // narrowing line's link): see NarrowingContext.
  const narrowing = useMemo(() => ({
    search: search.terms.length > 0,
    unread: unreadOnly,
    filters: activityFiltered || resourcesFiltered,
    clearAll: () => {
      everything.seeEverything()
      activity.clearFilters() // clears the event types with it (useActivityFilter)
      resourcesView.setFilter(EMPTY_FILTER)
    },
  }), [search.terms, unreadOnly, activityFiltered, resourcesFiltered, everything, activity.clearFilters, resourcesView])
  const searchOrUnread = narrowing.search || unreadOnly
  // Each pane heads its results with how many are left, while anything
  // narrows it; the line says it, so the lists show no empty text then.
  const worktrees = (
    <Stack gap="xs">
      {(searchOrUnread || sourcesOn) && (
        <SearchSummary
          count={shownWorktrees.length}
          noun={["worktree", "worktrees"]}
          qualifier={withUnread}
          filtered={sourcesOn}
        />
      )}
      <WorktreeList
      items={shownWorktrees}
      // Only once there are worktrees to hide: with none at all, the usual
      // "create one" hint is the more useful thing to say.
      emptyText={sortedWorktrees.length === 0 ? undefined : null}
      />
    </Stack>
  )
  const resourcesSummary = (searchOrUnread || resourcesFiltered) && (
    <SearchSummary
      count={resourcesView.shown.length}
      noun={["resource", "resources"]}
      qualifier={withUnread}
      filtered={resourcesFiltered}
    />
  )
  // While searching, each tab shows how many results it holds ("N+" when
  // the feed has more pages).
  const counting = search.terms.length > 0
  const countBadge = (n: number, more = false) =>
    counting ? <Badge size="xs" variant="light" ml={6}>{more ? `${n}+` : n}</Badge> : null

  // Wide, the right column's tab bar. As on the worktree page's resource
  // tabs, the active tab's controls sit at the bar's far end. It rides at
  // the top of whichever tab's pinned header is showing, so it stays in
  // reach as the column scrolls. The task panel is not in that header: it
  // sits above it, in the column's flow, and scrolls away.
  const rightTabBar = (
    <Tabs value={rightTab} onChange={(v) => v && setRightTab(v as RightTab)}>
      <Tabs.List>
        <Tabs.Tab value="timeline">Activity{countBadge(activity.events.length, activity.hasMore)}</Tabs.Tab>
        <Tabs.Tab value="resources">Resources{countBadge(resourcesView.shown.length)}</Tabs.Tab>
        <Group ml="auto" align="center" gap="md" wrap="nowrap" pb={4}>
          {rightTab === "timeline" ? activity.controls : <ResourcesTabControls view={resourcesView} />}
        </Group>
      </Tabs.List>
    </Tabs>
  )

  const suggestions = buildSuggestions({
    terms: search.terms,
    worktrees: shownWorktrees.map((w) => ({
      w, workspaceTitles: (cmux.data?.available ? cmux.data.matches?.[w.path] ?? [] : []).map((m) => m.title),
      resources: resourcesByPath.get(w.path) ?? w.focus_resources,
    })),
    resources: resourcesView.shown.map((r) => ({ r, worktreePath: r.worktrees[0]?.path })),
    tasks: tasks.tasks,
    events: activity.events,
    go: {
      worktree: (p) => navigate(`/worktree/${encodeURIComponent(p)}`),
      resource: (r, p) => {
        const followers = resourcesView.shown.find((x) => x.type === r.type && x.id === r.id)?.worktrees ?? []
        if (followers.length > 1) setChoosing({ r, worktrees: followers })
        else if (p) openResourceIn(p, r)
      },
      // An archived or worktree-less event opens its details; see pickEvent.
      event: activity.pickEvent,
      task: openTask,
    },
  })
  // Esc sees everything: clears the search and turns Unreads only off. With
  // nothing to clear it goes to the tab's home worktree, when it has one —
  // the listing is otherwise the top, with nowhere further to back out to.
  // The banner pointing there carries its hint (see escapeHint), and
  // dismissing it takes the shortcut with it (see useEscHome).
  const escClears = narrowing.search || narrowing.unread || narrowing.filters
  const home = useEscHome()
  usePublishEscLeaves(!escClears && home !== null)
  const searchBar = (
    <SearchBar
      value={search.q}
      onChange={search.setQ}
      suggestions={suggestions}
      onEscape={narrowing.clearAll}
      escapeActive={escClears}
      onEscapeIdle={home ? () => navigate(homeWorktreeHref(home)) : undefined}
    />
  )
  const header = <HomeHeader search={searchBar} unreadOnly={unreadOnly} onUnreadOnlyChange={setUnreadOnly} hasUnread={unreadBadge(wts.data).unread} />
  const detailsModal = (
    <>
      {activity.modals}
      <ChooseWorktreeModal
        r={choosing?.r ?? null}
        worktrees={choosing?.worktrees ?? []}
        onPick={(path) => {
          const c = choosing
          setChoosing(null)
          if (c) openResourceIn(path, c.r)
        }}
        onClose={() => setChoosing(null)}
      />
    </>
  )

  // Narrow: the two panes would otherwise stack, pushing the worktree list
  // far off-screen, so offer them as tabs instead.
  if (!wide) {
    return (
      <NarrowingContext.Provider value={narrowing}><SearchContext.Provider value={searchContext}><CrossHoverProvider>
        <Stack p="md" gap="sm">
          <NewWorktreeModal opened={newOpen} onClose={() => setNewOpen(false)} />
          {detailsModal}
          {header}
          {tasks.panel}
          <Tabs value={narrowTab} onChange={(v) => v && setNarrowTab(v as NarrowTab)}>
            <Tabs.List>
              <Tabs.Tab value="worktrees">Worktrees{countBadge(shownWorktrees.length)}</Tabs.Tab>
              <Tabs.Tab value="timeline">Activity{countBadge(activity.events.length, activity.hasMore)}</Tabs.Tab>
              <Tabs.Tab value="resources">Resources{countBadge(resourcesView.shown.length)}</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="worktrees" pt="md">
              <Stack gap="xs">
                {listToolbar(false)}
                {worktrees}
              </Stack>
            </Tabs.Panel>
            <Tabs.Panel value="timeline" pt="md">{activity.render(undefined, headerStyle)}</Tabs.Panel>
            <Tabs.Panel value="resources" pt="md">
              <ResourcesPanel
                view={resourcesView}
                top={<ResourcesTabControls view={resourcesView} />}
                searchSummary={resourcesSummary}
              />
            </Tabs.Panel>
          </Tabs>
        </Stack>
      </CrossHoverProvider></SearchContext.Provider></NarrowingContext.Provider>
    )
  }

  const split = tasks.expanded ? [4, 8] : [6, 6]
  return (
    // The header sits above the columns. Even split below it — except while
    // the task panel, which heads the right-hand column, is fully expanded
    // (Show all): then 4/8, as the worktree page splits for a selected
    // resource, so the long list gets the width. The worktree
    // cards carry more per row than they used to — a cmux workspace header,
    // two meta lines, focus resources — so the narrower column was wrapping
    // content that the timeline had width to spare for.
    //
    // Each column is its own scroller, sized to what is left under the
    // header (see columnStyle), so the page itself does not scroll (unless a
    // banner above it adds its own height). No overflow on the Grid itself —
    // its row's negative margins would show as a sideways scrollbar.
    <NarrowingContext.Provider value={narrowing}><SearchContext.Provider value={searchContext}><CrossHoverProvider>
      <Box px="md" pt="md" ref={headerRef}>{header}</Box>
      <Grid px="md" pb="md" pt="sm" gutter="md">
        {/* Tooltips in both columns open under the pinned headers while
            those are stuck; see useTooltipLayer. */}
        <Grid.Col span={split[0]} style={columnStyle} data-tooltip-layer="content">
          {/* As the Activity header: pinned, it carries its own opaque room
              below the toolbar in place of the gap, so the cards scrolling
              under it do not run right up against the buttons. */}
          <Stack gap={headerStyle ? 0 : "sm"}>
            <Box
              style={headerStyle && { ...headerStyle, paddingBottom: "var(--mantine-spacing-xs)" }}
              data-worktrees-header
              data-tooltip-layer={headerStyle ? "pinned" : undefined}
            >
              {listToolbar(true)}
            </Box>
            {worktrees}
          </Stack>
        </Grid.Col>
        <Grid.Col span={split[1]} style={columnStyle} data-tooltip-layer="content">
          {/* The task panel scrolls away with the column; the tab's header
              below it, carrying the tab bar, pins once scrolled to. Its
              cover (the column padding) is less than this gap, so pinning
              never paints over the panel's bottom edge. */}
          <Stack gap="sm">
            {tasks.panel}
            {rightTab === "timeline" && activity.render(rightTabBar, headerStyle)}
            {rightTab === "resources" && (
              <ResourcesPanel view={resourcesView} headerStyle={headerStyle} top={rightTabBar} searchSummary={resourcesSummary} />
            )}
          </Stack>
        </Grid.Col>
        <NewWorktreeModal opened={newOpen} onClose={() => setNewOpen(false)} />
        {detailsModal}
      </Grid>
    </CrossHoverProvider></SearchContext.Provider></NarrowingContext.Provider>
  )
}
