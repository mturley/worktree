import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { Anchor, Badge, Box, Grid, Group, MantineThemeProvider, Stack, Tabs, Title } from "@mantine/core"
import { Link, useLocation, useRoute } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import { NotifySwitch } from "../components/NotifySwitch"
import { FollowingCmuxBanner } from "../components/FollowingCmuxBanner"
import { Logo } from "../components/Logo"
import { IconChevronLeft } from "@tabler/icons-react"
import { useNotifyMode } from "../hooks/useNotifyMode"
import { TAB_ID } from "../lib/tabId"
import { useWorktreeDetail } from "../hooks/useWorktreeDetail"
import { SELECTION_PARAMS, useSelectedResource } from "../hooks/useSelectedResource"
import { useIsWide } from "../hooks/useIsWide"
import { useIsTall } from "../hooks/useIsTall"
import { useDetailTab } from "../hooks/useDetailTab"
import { useDiffView } from "../hooks/useDiffView"
import { useReviewSidebar } from "../hooks/useReviewSidebar"
import { useWorktrees } from "../hooks/useWorktrees"
import { UnreadMarkerDot } from "../components/UnreadMarkerDot"
import { useCmuxMatches } from "../api/cmux"
import { ResourceList } from "../components/ResourceList"
import { pinnedStyle, STICKY_LIST_SCROLLER, stickyListStyle } from "../lib/stickyList"
import { ResourceDetailPane } from "../components/ResourceDetailPane"
import { TimelineFeed } from "../components/TimelineFeed"
import { EventDetailsModal } from "../components/EventDetailsModal"
import {
  clearFollowResource, clearOpenEvent, messageFocus, readFollowResource, readOpenEvent,
  type FollowResource, type MessageFocus,
} from "../lib/openEvent"
import type { TaskEventSnapshot, TimelineEvent } from "../api/types"
import { WorktreeDetailCard } from "../components/WorktreeDetailCard"
import { CmuxWorkspaceActions, CmuxWorkspaceTitles } from "../components/CmuxWorkspaceHeader"
import { SourceFilter } from "../components/SourceFilter"
import { EventTypeFilter } from "../components/EventTypeFilter"
import { useActivityFilter } from "../hooks/useActivityFilter"
import { RefreshWatchersButton } from "../components/RefreshWatchersButton"
import { MarkAllReadButton } from "../components/MarkAllReadButton"
import { UnreadOnlyToggle } from "../components/UnreadOnlyToggle"
import { useUnreadOnly } from "../hooks/useUnreadOnly"
import { useUnreadOnlyHotkey } from "../hooks/useUnreadOnlyHotkey"
import { useBannerShown, usePublishEscLeaves } from "../lib/escapeHint"
import { KeyHint } from "../components/search/KeyHint"
import { hasUnread } from "../lib/unread"
import { matchesSources } from "../lib/sourceFilter"
import { ThreadActionsContext } from "../components/slack/ThreadActionsContext"
import { LinkedActionsContext } from "../components/linked/LinkedActionsContext"
import { AddResourceModal } from "../components/AddResourceModal"
import { parseThreadUrl } from "../lib/parseThreadUrl"
import { WorktreeGlyph } from "../components/WorktreeGlyph"
import { homeWorktreeHref, useEscHome, worktreeName } from "../lib/homeWorktree"
import { SearchBar } from "../components/search/SearchBar"
import { SearchSummary } from "../components/search/SearchSummary"
import { useSeeEverything } from "../hooks/useSeeEverything"
import { NarrowingContext } from "../components/search/NarrowingContext"
import { SearchContext } from "../components/search/SearchContext"
import { buildSuggestions } from "../components/search/suggestions"
import { useSearchQuery } from "../hooks/useSearchQuery"
import { matchResource } from "../lib/search"
import { CrossHoverProvider } from "../components/CrossHoverContext"
import { DiffViewBoundary, installPreloadReload } from "../components/gitdiff/DiffViewBoundary"
import { useTasksPanel } from "../components/tasks/TasksSection"
import { serializeResourceKey } from "../lib/resourceKey"
import { useMakeTask, useMakeTaskFromEvent } from "../components/tasks/useMakeTask"
import { useTaskModal } from "../components/tasks/modal/TaskModalProvider"

// The diff drill-down, and with it @pierre/diffs, is its own chunk: fetched
// the first time someone opens a diff, never on a plain page load.
const DiffView = lazy(() => import("../components/gitdiff/DiffView"))
// A chunk missing after an upgrade reloads the page (once) instead of failing.
installPreloadReload()

type NarrowTab = "resources" | "activity"

export function WorktreeDetailPage() {
  const [, params] = useRoute("/worktree/:path*")
  const [, navigate] = useLocation()
  const rawPath = params?.["path*"]
  const path = rawPath ? decodeURIComponent(rawPath) : ""
  // "Make task" from an event or a Slack message, acting in this worktree.
  const makeTask = useMakeTask(path)
  const makeTaskFromEvent = useMakeTaskFromEvent(path)
  // A task event's row opens its task, over this page.
  const { open: openTask } = useTaskModal()
  // Narrows the worktree's unified feed and the resource list. Selecting a
  // resource already narrows the timeline to that one resource, so the
  // toggles are hidden there rather than left as dead controls.
  const { sources, setSources, categories, setCategories, eventTypes } = useActivityFilter()
  // Shared with the home page and every other tab. Narrows the resource list
  // and the worktree's unified feed; a selected resource's own feed is left
  // whole, its unread events already together at the top under the divider.
  const [unreadOnly, setUnreadOnly] = useUnreadOnly()
  useUnreadOnlyHotkey(unreadOnly, setUnreadOnly)
  // Narrows only this worktree's resources and activity; the query lives in
  // the URL, shared with the resource's own feed (ResourceDetailPane).
  const search = useSearchQuery()
  const everything = useSeeEverything()
  const sourcesOn = sources.length > 0
  const searchContext = useMemo(() => ({ terms: search.terms }), [search.terms])
  const { resources, timeline, refreshResources } = useWorktreeDetail(path, sources, unreadOnly, eventTypes, search.debouncedQ)
  const { selected, select, toggle, clear } = useSelectedResource()
  // `?diff`: the Code tab's drill-down replaces the page body (the details
  // card and the resources) under the same header.
  const diffView = useDiffView()
  const inDiff = diffView.open
  // DiffView closes this itself when there is nothing to list, so the flag
  // is "the sidebar is showing". Esc closes it before it leaves the diff.
  const [sidebarOpen, setSidebarOpen] = useReviewSidebar()
  // The details card's tab is the page's: it decides where the card sits
  // (see inColumn below), and Esc returns it to Notes.
  const detailTab = useDetailTab(path, inDiff)
  // What Esc does next, so its hint sits on the control that does the same:
  // the Notes tab, the narrowing lines' links (their own hint), "← all
  // resources", then the way out — the banner's, when it is up (see
  // escapeHint), else the logo's. The tab's home worktree is where Esc ends
  // up, so on it there is no way out; a dismissed home banner drops the home
  // (see useEscHome).
  const escHome = useEscHome()
  // A query in the search bar comes first, wherever Esc is pressed: the bar
  // shows its own Esc hint beside it, and only one control hints Esc at a
  // time. Then, in the diff drill-down, Esc goes back to the worktree: the
  // other narrowing and the selection it would undo are out of view. Then,
  // with the card off Notes, it returns the card to Notes (and so, wide, to
  // the resource column) before undoing anything else: Notes is the card's
  // home, as its X and the titles' reset already treat it.
  const queryOn = search.q.length > 0
  const escDiff = inDiff && !queryOn
  const escNotes = !inDiff && !queryOn && detailTab.tab !== "notes"
  const filtersOn = sourcesOn || categories.length > 0
  const barClears = queryOn || (!inDiff && (unreadOnly || filtersOn))
  const escClears = !escNotes && barClears
  const escDeselects = !inDiff && !escNotes && !escClears && Boolean(selected)
  const escLeaves = !inDiff && !escNotes && !escClears && !selected && escHome !== path
  usePublishEscLeaves(escLeaves)
  // Everything that narrows the page, and the one way back (Esc, and every
  // narrowing line's link): see NarrowingContext. The source toggles narrow
  // the resource list as well as the feed; the event types only the feed.
  const narrowing = useMemo(() => ({
    search: search.terms.length > 0,
    unread: unreadOnly,
    filters: filtersOn,
    // With a query the bar's own hint already says it.
    escHint: escClears && !queryOn,
    clearAll: () => {
      everything.seeEverything()
      setSources([]) // clears the event types with it (useActivityFilter)
    },
  }), [search.terms, unreadOnly, filtersOn, escClears, queryOn, everything, setSources])
  const bannerShown = useBannerShown()
  const wide = useIsWide()
  // The details card and a selected resource's tab bar are pinned while
  // the page or the resource column scrolls — but only with room to spare. On
  // a phone or a short window they would leave too little for what scrolls
  // beneath them, so they scroll away and only the title row stays pinned.
  const tall = useIsTall()
  const pinCards = wide && tall
  const worktrees = useWorktrees()

  const items = useMemo(() => resources.data ?? [], [resources.data])
  // Memoized, not just derived: ResourceList drops its optimistic order
  // whenever this array changes identity, so a fresh one per render would
  // undo every drag before the save landed.
  const selType = selected?.type
  const selId = selected?.id
  const shownItems = useMemo(
    () => items.filter((r) =>
      (!unreadOnly || hasUnread(r)) && matchesSources(r.type, sources) &&
      // The selected resource stays listed while searching: typing must not
      // deselect it (the stale-selection effect below would).
      (search.terms.length === 0 || matchResource(r, search.terms) !== null ||
        (r.type === selType && r.id === selId))),
    [items, unreadOnly, sources, search.terms, selType, selId],
  )
  const filtered = unreadOnly || sources.length > 0 || search.terms.length > 0
  const summary = (worktrees.data ?? []).find((w) => w.path === path)
  const notifyMode = useNotifyMode()
  const qc = useQueryClient()
  const notify = useMemo(
    () => ({ all: Boolean(summary?.notify_all), mode: notifyMode }),
    [summary?.notify_all, notifyMode],
  )
  const name = worktreeName(path)
  const hasWorkspace = useCmuxMatches(path).length > 0
  // Against the SHOWN list: with unread only on, a resource that is marked
  // read leaves the list, and the effect below then deselects it rather than
  // leaving its detail open beside a list that no longer has it.
  const selectedResource = selected
    ? shownItems.find((r) => r.type === selected.type && r.id === selected.id)
    : undefined

  // A ?resource= pointing at something this worktree no longer has (removed
  // out-of-band, or a stale shared link) must not leave an empty pane. This
  // is an automatic correction of invalid input, not a deliberate deselect,
  // so it must REPLACE the history entry rather than push a new one — a push
  // here would trap the back button (stale -> clean -> back -> stale -> the
  // effect fires again and pushes clean again, forever).
  //
  // The same goes for a resource "Unreads only" hides, including one the
  // user just marked read: there is no back to return to it while the filter
  // stands, so a push would only add a dead entry.
  useEffect(() => {
    if (selected && resources.data && !selectedResource) clear({ replace: true })
  }, [selected, resources.data, selectedResource, clear])

  // An event the home page's activity feed was clicked on to get here: its
  // details open over the resource it navigated to. Read once, at mount — the
  // home page is the only way in with one — and then dropped from the history
  // entry so a reload or a back/forward onto this page does not reopen it.
  // Cleared in an effect rather than in the initializer, which StrictMode runs
  // twice: clearing there would leave the second run with nothing to read.
  //
  // A Slack message is the exception: it is brought into view in its thread
  // instead, which shows it in full and in context — see messageFocus.
  const [arrival] = useState<TimelineEvent | null>(readOpenEvent)
  const [openedEvent, setOpenedEvent] = useState<TimelineEvent | null>(
    () => (arrival && !messageFocus(arrival) ? arrival : null),
  )
  const [focus, setFocus] = useState<MessageFocus | null>(() => (arrival ? messageFocus(arrival) : null))
  useEffect(() => clearOpenEvent(), [])
  // Arriving from an archived event's "Follow" menu on the home page: open
  // the follow modal prefilled, leaving Focus/Related and position to choose.
  const [arrivalFollow, setArrivalFollow] = useState<FollowResource | null>(readFollowResource)
  useEffect(() => clearFollowResource(), [])
  // The activity feed does what arriving from the home page does: selects
  // the event's resource, then opens the event's details over it — or, for a
  // Slack message, brings it into view in its thread. Selecting alone left
  // you to find the entry you clicked again in the resource's own feed.
  const selectFromEvent = (key: { type: string; id: string }, e: TimelineEvent) => {
    select(key)
    const f = messageFocus(e)
    if (f) setFocus(f)
    else setOpenedEvent(e)
  }
  const resolveResource = (type: string, id: string) => items.find((r) => r.type === type && r.id === id)

  // Thread-unfurl actions live here because this is the only place that knows
  // BOTH the worktree's resource list (is this thread already tracked?) and
  // the selection state (show it). Deriving "tracked" from the list rather
  // than from what was just added keeps the unfurl button correct across
  // navigation and for threads added elsewhere.
  // URL of a thread the user asked to add from a Slack unfurl; non-null while
  // the pre-filled add modal is open.
  const [pendingThreadUrl, setPendingThreadUrl] = useState<string | null>(null)
  // URL the user asked to follow from the Linked Resources tab; non-null
  // while the pre-filled add modal is open.
  const [pendingFollowUrl, setPendingFollowUrl] = useState<string | null>(null)
  // The card's tab also decides where it sits, wide: Notes in the resource
  // column above Follow resource, so the activity column gets the page's
  // height; Code, Environment and cmux, which want the width, under the
  // header. Narrow has no side column, so the card is always under the header.
  const inColumn = wide && detailTab.tab === "notes"
  // Narrow only: which of Resources / Activity is showing.
  const [narrowTab, setNarrowTab] = useState<NarrowTab>("resources")
  // The worktree's task panel, above the tab bar. A selected resource's pane
  // shows its own (see ResourceDetailPane). This hook outlives the panel
  // while a resource is selected, so the selection resets an expanded panel:
  // coming back from a resource shows it normal.
  const taskScope = useMemo(() => ({ kind: "worktree" as const, path }), [path])
  // The page header's measured height (see the ResizeObserver below).
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = useState(0)
  const tasks = useTasksPanel(taskScope, { resetKey: selected ? serializeResourceKey(selected) : "" })

  // The sticky resource list has to start below the header, and the header's
  // height is not a constant: the worktree and cmux workspace names wrap, and
  // the details card's tabs differ in height. A hardcoded offset would leave
  // the list overlapping the header or floating below it, so measure the real
  // thing.
  useEffect(() => {
    const el = headerRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => {
      // getBoundingClientRect, NOT entry.contentRect: contentRect excludes
      // padding, and this header carries a padding-top equal to the shell's
      // gutter so its sticky box covers it. Using contentRect left the offset
      // exactly that padding too small, and the list overlapped the bottom of
      // the header by 16px.
      setHeaderHeight(Math.round(el.getBoundingClientRect().height))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

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
    makeTask: (key: string, snapshot: TaskEventSnapshot) => void makeTask(key, snapshot),
  }

  const linkedActions = {
    requestFollow: (url: string) => setPendingFollowUrl(url),
    trackedResource: (type: string, id: string) => {
      const hit = items.find((r) => r.type === type && r.id === id)
      return hit ? { type: hit.type, id: hit.id } : null
    },
    selectResource: (key: { type: string; id: string }) => select(key),
  }

  // Keyed by path: the card holds an unsaved notes draft, which must never
  // carry over to another worktree.
  const card = summary && (
    <WorktreeDetailCard
      key={summary.path}
      w={summary}
      tab={detailTab.tab}
      onTabChange={detailTab.select}
      escHint={escNotes}
    />
  )

  const list = (
    <ResourceList
      items={shownItems}
      allItems={filtered ? items : undefined}
      // With none followed at all, the list's own hint; narrowed, the
      // "0 resources …" line above says it.
      emptyText={items.length === 0 ? undefined : null}
      aboveList={(narrowing.search || unreadOnly || sourcesOn) && (
        // Searching, matches only: the selection kept listed while it
        // doesn't match (see shownItems) is not a result.
        <SearchSummary
          count={search.terms.length > 0
            ? shownItems.filter((r) => matchResource(r, search.terms) !== null).length
            : shownItems.length}
          noun={["resource", "resources"]}
          qualifier={unreadOnly ? "with unread events" : undefined}
          filtered={sourcesOn}
        />
      )}
      toolbar={
        <Group gap="lg" align="center">
          <UnreadOnlyToggle value={unreadOnly} onChange={setUnreadOnly} hasUnread={!!summary?.has_unread} />
          <NotifySwitch
            label="Notify on all"
            tooltip="Notify on new events for all resources in this worktree"
            checked={notify.all}
            mode={notify.mode}
            onToggle={async (on) => {
              await api.setNotify({ path, on, tab: TAB_ID })
              await Promise.all([
                qc.invalidateQueries({ queryKey: ["worktrees"] }),
                qc.invalidateQueries({ queryKey: ["resources"] }),
              ])
            }}
          />
        </Group>
      }
      path={path}
      onChanged={refreshResources}
      selectedKey={selected}
      onSelectResource={toggle}
      notify={notify}
    />
  )

  // The Activity tab's own controls: refresh, the watcher log and mark all
  // read. Wide, at the tab bar's far end; narrow, heading the feed.
  const activityControls = (
    <Group gap={6} wrap="nowrap" align="center" data-testid="activity-controls">
      <RefreshWatchersButton />
      {/* Only over the whole feed: it marks every unread event, so
          beside a narrowed feed it would clear what is not shown. */}
      {!narrowing.search && !narrowing.filters && (
        <MarkAllReadButton
          resources={items}
          feed={{ worktree: path, resolveResource, path }}
          taskScope={{ kind: "worktree", path }}
        />
      )}
    </Group>
  )

  // Pinned under the page header while the column scrolls beneath — with
  // room to spare only, like the cards. Opaque room below, so the content
  // passing under it does not run right up against the buttons. The task
  // panel is never in it: wide, it sits above the header and scrolls away.
  const headerStyle = pinCards
    ? { ...pinnedStyle(headerHeight, "var(--mantine-spacing-md)"), paddingBottom: "var(--mantine-spacing-xs)" }
    : undefined

  // Wide, nothing selected: the right column's tab bar, with the activity
  // controls at its far end, as on the home page.
  const rightTabBar = (
    <Tabs value="activity">
      <Tabs.List>
        <Tabs.Tab value="activity">Activity</Tabs.Tab>
        <Group ml="auto" align="center" gap="md" wrap="nowrap" pb={4}>
          {activityControls}
        </Group>
      </Tabs.List>
    </Tabs>
  )

  const unfiltered = (top?: ReactNode) => (
    // No gap below the header when pinned: its own padding is that space.
    <Stack gap={headerStyle ? 0 : "sm"}>
      {/* Pinned under the page header, with the filters, while the feed
          scrolls beneath. */}
      <Stack
        gap="sm"
        data-activity-header
        data-tooltip-layer={headerStyle ? "pinned" : undefined}
        style={headerStyle}
      >
        {/* Wide, the tab bar, which carries the controls; narrow, where the
            page's tab bar is above, the controls alone. */}
        {top ?? activityControls}
        <Group justify={wide ? "flex-end" : "flex-start"}>
          <SourceFilter value={sources} onChange={setSources} />
        </Group>
        {/* Right-aligned under the source toggles when they sit at the right
            of the header; narrow, the header wraps them to the left. */}
        <EventTypeFilter
          sources={sources}
          value={categories}
          onChange={setCategories}
          justify={wide ? "flex-end" : "flex-start"}
        />
        {/* Directly above the results it counts. Only once the feed holds
            the results for what is typed: during the debounce it would count
            the old ones. */}
        {(narrowing.search || unreadOnly || narrowing.filters) && search.debouncedQ === search.q.trim() && !timeline.isLoading && (
          <SearchSummary
            count={timeline.events.length}
            more={timeline.hasMore}
            noun={unreadOnly ? ["unread event", "unread events"] : ["event", "events"]}
            filtered={narrowing.filters}
          />
        )}
      </Stack>
      <TimelineFeed
        events={timeline.events}
        loading={timeline.isLoading}
        error={timeline.error}
        hasMore={timeline.hasMore}
        onLoadMore={timeline.loadMore}
        loadingMore={timeline.loadingMore}
        // Searching or unread only, the "0 … events" line above says it.
        emptyText={narrowing.search || unreadOnly || narrowing.filters ? null : undefined}
        // Only meaningful here: this page has a selection to change, and the
        // worktree's own resource list to resolve icons and titles against.
        onSelectResource={selectFromEvent}
        resolveResource={resolveResource}
        path={path}
        onMakeTask={makeTaskFromEvent}
        onOpenTask={openTask}
      />
    </Stack>
  )

  // Side by side, the resource list stays put while the page scrolls past it
  // — beside the activity feed and beside a selected resource alike. See
  // stickyListStyle for why the offset is not simply headerHeight.
  const listSticky = stickyListStyle(headerHeight)

  // Where the resource list's tooltips open: inside the sticky column's
  // stacking context (outside its scroller, so they are not clipped), layered
  // above the list's cards and below the pinned notes card — so a tooltip
  // left open as its card scrolls up goes under the notes card. Portalled to
  // <body>, as tooltips otherwise are, it could only be above or below the
  // whole column. Scoped to the list alone, so the notes card's own tooltips
  // still open above everything.
  const [listTooltipTarget, setListTooltipTarget] = useState<HTMLDivElement | null>(null)
  const listTooltipTheme = useMemo(
    () => ({
      components: {
        Tooltip: {
          defaultProps: { portalProps: { target: listTooltipTarget ?? undefined } },
          // Sized to their text (up to any max width they set), not to the
          // room left between them and the target's edge: the column, unlike
          // <body>, is narrow enough that a tooltip near its right edge was
          // squeezed to a word per line.
          styles: { tooltip: { width: "max-content" } },
        },
      },
    }),
    [listTooltipTarget],
  )

  const detail = selectedResource && (
    <ResourceDetailPane
      path={path}
      resource={selectedResource}
      // Also on wide: deselecting is how you get the worktree's activity feed
      // back, and it was previously only reachable by clicking the selected
      // card again.
      onBack={clear}
      escHint={escDeselects}
      onRemoved={refreshResources}
      onResourceChanged={refreshResources}
      topInset={headerHeight}
      stickyTop={pinCards ? headerHeight : undefined}
      notify={notify}
      focus={
        focus && focus.type === selectedResource.type && focus.id === selectedResource.id
          ? { ts: focus.ts, key: focus.key }
          : undefined
      }
    />
  )

  let overview
  if (!wide) {
    // Narrow + a selection drills down, replacing everything — there is no
    // room to keep a navigator beside the resource. With nothing selected the
    // list and the feed would otherwise stack, pushing the feed far below the
    // resources, so they are tabs instead, as on the home page. The tab is
    // page state rather than the Tabs' own, so backing out of a drill-down
    // lands on the tab you left.
    // The task panel sits above the tabs, as on the home page.
    overview = detail || (
      <Stack gap="sm">
        {tasks.panel}
        <Tabs value={narrowTab} onChange={(v) => setNarrowTab((v as NarrowTab | null) ?? "resources")}>
          <Tabs.List>
            <Tabs.Tab value="resources">Resources</Tabs.Tab>
            <Tabs.Tab value="activity">Activity</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="resources" pt="md">{list}</Tabs.Panel>
          <Tabs.Panel value="activity" pt="md">{unfiltered()}</Tabs.Panel>
        </Tabs>
      </Stack>
    )
  } else {
    // 4/8 as well while the task panel is fully expanded (Show all): the
    // panel heads the right-hand column, and a long list reads better wide.
    const split = selectedResource || tasks.expanded ? [4, 8] : [6, 6]
    // One Grid in both states, deliberately. Swapping the wide layout
    // between containers would put `list` at a different position in the
    // React tree, remounting it on every selection change — losing its
    // scroll position and flickering. Changing only the SPANS keeps it
    // mounted: an even split while the list sits beside the worktree's
    // activity feed, its peer, and 4/8 once a selected resource's detail —
    // which carries more — takes the right-hand column.
    overview = (
      <Grid
        gutter="md"
        // No overflow here on purpose. Mantine's Grid inner carries negative
        // margins to offset the columns' padding, so making the Grid a scroll
        // container exposes those as HORIZONTAL overflow — a stray sideways
        // scrollbar.
        style={{ margin: 0 }}
      >
        <Grid.Col span={split[0]} style={listSticky}>
          {/* Above the list's cards (auto), below the pinned notes card (app
              - 1), all within this column's stacking context; see
              listTooltipTarget. Never takes the pointer, being over the
              list. */}
          <div
            ref={setListTooltipTarget}
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              zIndex: "calc(var(--mantine-z-index-app) - 2)",
            }}
          />
          <Box style={STICKY_LIST_SCROLLER}>
            {/* Always this Stack, with the card's slot first even when empty:
                wrapping `list` only while collapsed would move it in the tree
                and remount it, for the reason above. */}
            <Stack gap={0}>
              {inColumn && (
                // Pinned to the top of the scroller while the resource list
                // scrolls under it (once the list outgrows the screen). The
                // gap to the list below is MARGIN, not padding: transparent,
                // so the list scrolls right up to the card's edge rather than
                // vanishing behind an opaque band, as the activity does under
                // a resource's tabs. Capped so long notes scroll inside the
                // card rather than crowding out the list. The scroller has no
                // padding, so there is no strip above the card to cover.
                <Box
                  style={
                    pinCards
                      ? { ...pinnedStyle(0, "0px"), marginBottom: "var(--mantine-spacing-md)" }
                      : { marginBottom: "var(--mantine-spacing-md)" }
                  }
                >
                  <Box style={pinCards ? { maxHeight: "40dvh", overflowY: "auto" } : undefined}>{card}</Box>
                </Box>
              )}
              <MantineThemeProvider theme={listTooltipTheme}>{list}</MantineThemeProvider>
            </Stack>
          </Box>
        </Grid.Col>
        {/* No scroller: this column's content is what the PAGE scrolls.
            Its tooltips open under the pinned blocks; see useTooltipLayer. */}
        <Grid.Col span={split[1]} data-tooltip-layer="content">
          {detail || (
            // The task panel scrolls away with the page; the activity header
            // below it pins once scrolled to. The gap is the header's cover
            // (md; see pinnedStyle), so pinning never paints over the panel.
            <Stack gap={headerStyle ? "md" : "sm"}>
              {tasks.panel}
              {unfiltered(rightTabBar)}
            </Stack>
          )}
        </Grid.Col>
      </Grid>
    )
  }

  // Anything the titles' reset would undo; with none of it, they are plain
  // text rather than a button that does nothing.
  const narrowed = Boolean(selectedResource) || unreadOnly
  const resettable = narrowed || inDiff || detailTab.tab !== "notes"
  const showOverview = () => {
    // Out of the diff drill-down too, clearing the selection in the same
    // navigation: two URL writes in one tick would drop the first.
    if (inDiff) diffView.leave({}, selectedResource ? SELECTION_PARAMS : [])
    else if (selectedResource) clear()
    if (unreadOnly) setUnreadOnly(false)
    // Back to the Notes tab too, and so (wide) the card back into the column.
    if (detailTab.tab !== "notes") detailTab.select("notes")
  }

  // Left-aligned either way. Wide, it sits right after the titles (see the
  // header below); narrow, it leads the toolbar's own row and the auto
  // margin pushes everything else to the right. (Open in editor lives in the
  // Code tab, beside Review changes.)
  const cmuxButton = summary && (
    <Group gap="xs" wrap="nowrap" style={{ flex: "none" }}>
      <CmuxWorkspaceActions path={path} branch={summary.branch} />
    </Group>
  )

  const suggestions = buildSuggestions({
    terms: search.terms,
    resources: shownItems.map((r) => ({ r })),
    tasks: tasks.tasks,
    events: timeline.events,
    go: {
      worktree: () => {},
      resource: (r) => select({ type: r.type, id: r.id }),
      event: (e) => selectFromEvent({ type: e.resource_type, id: e.resource_id }, e),
      task: openTask,
    },
  })
  // Wide, it takes the width the titles leave free; narrow, it sits right
  // after the cmux button, filling the rest of the row.
  // Esc with nothing left to clear: deselect, then leave — for the tab's
  // home worktree when it has one, else for the listing. On the home
  // worktree itself it stops at deselecting.
  const escapeIdle = () => {
    if (inDiff && sidebarOpen) { setSidebarOpen(false); return }
    if (inDiff) { diffView.leave(); return }
    if (selected) { clear(); return }
    if (!escLeaves) return
    navigate(escHome ? homeWorktreeHref(escHome) : "/")
  }
  const searchBar = (
    <div style={wide ? { flex: "1 1 160px", minWidth: 0 } : { flex: "1 1 160px", marginRight: "auto" }}>
      {/* Esc backs out a level at a time: a query first, then out of the
          diff drill-down, the card back to Notes, then it sees everything
          (clears Unreads only and filters), then deselects, then leaves. */}
      <SearchBar
        value={search.q}
        // Search results live in the worktree view, so typing leaves the
        // drill-down for it — in one navigation, or the two URL writes
        // would race and one would be lost (see useDiffView's leave).
        onChange={(q) => (inDiff ? diffView.leave(q ? { q } : {}) : search.setQ(q))}
        placeholder="Search this worktree…"
        suggestions={suggestions}
        onEscape={narrowing.clearAll}
        escapeActive={barClears}
        onEscapeIdle={escapeIdle}
        onEscapeFirst={escNotes ? () => detailTab.select("notes") : undefined}
      />
    </div>
  )

  // Wide, the cmux button and search bar sit beside the titles. Narrow, they
  // get a row of their own (kept beside the titles, they left them a sliver
  // of width that wrapped them a few letters per line).
  const toolbar = !wide && (
    <Group gap="xs" wrap="wrap" justify="flex-end" data-detail-toolbar>
      {cmuxButton}
      {searchBar}
    </Group>
  )

  return (
    <NarrowingContext.Provider value={narrowing}><SearchContext.Provider value={searchContext}><CrossHoverProvider>
    <ThreadActionsContext.Provider value={threadActions}>
    <LinkedActionsContext.Provider value={linkedActions}>
    {/*
      The DOCUMENT scrolls, not an element inside the page.

      This page used to own the viewport (100dvh + overflow:hidden) with inner
      scrollers. That works on desktop but breaks mobile browsers: they hide
      the address bar only when the page itself scrolls, and a page whose
      scrolling all happens in nested elements never triggers it. So the shell
      imposes no height, the header and the resource list are sticky instead,
      and the right-hand column simply flows.

      Nothing above this may set an overflow value either — sticky positioning
      dies silently under ANY scrolling ancestor. If the header stops sticking,
      look for a new overflow before looking here.

      The ONE deliberate exception is the diff drill-down (`?diff`): pierre's
      Virtualizer must own its scroll container, so DiffView sizes itself to
      the viewport below this header and scrolls inside. The header still
      sticks, since the scroller is below it rather than around it.
    */}
    <Stack p="md" gap="md">
      <Box
        ref={headerRef}
        data-page-header
        style={{
          position: "sticky",
          top: 0,
          // Mantine's z-index scale for app chrome (100), NOT a small number.
          // SegmentedControl's inner control/innerLabel are `position:relative;
          // z-index:2` and its ROOT is z-index:auto, so it creates no stacking
          // context and those 2s land in the same context as this header. A
          // header at 2 ties with them, DOM order decides, and the card below
          // paints over it. Still under modal (200) and popover (300), which
          // must stay above the header.
          zIndex: "var(--mantine-z-index-app)",
          // The shell's own padding sits above this box, so without covering
          // it the body would be visible sliding through that gap. Pulling up
          // by the padding and re-adding it as padding makes the sticky box
          // include it.
          marginTop: "calc(-1 * var(--mantine-spacing-md))",
          paddingTop: "var(--mantine-spacing-md)",
          // Narrow, the toolbar row (editor, search, actions) is the header's
          // last line, and content scrolling under it ran right up against
          // the search bar. The same trick at the bottom: opaque padding,
          // pulled back by the same margin so nothing moves at rest.
          ...(!wide && {
            paddingBottom: "var(--mantine-spacing-sm)",
            marginBottom: "calc(-1 * var(--mantine-spacing-sm))",
          }),
          background: "var(--mantine-color-body)",
        }}
      >
        <Stack gap="md">
          {/* In the sticky header, so the way to stop following stays in view. */}
          <FollowingCmuxBanner />
          <Group justify="space-between" wrap="nowrap" align="center" data-detail-header>
            <Group wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
              {/* The chevron and logo are one link back to the list. */}
              <Anchor
                component={Link}
                href="/"
                aria-label="All worktrees"
                underline="never"
                className="back-home"
              >
                <IconChevronLeft size={16} />
                <Logo exceptPath={path} />
                {escLeaves && !bannerShown && (
                  <span aria-hidden="true" style={{ display: "inline-flex", marginLeft: 4 }}><KeyHint>Esc</KeyHint></span>
                )}
              </Anchor>
              {/* Inside cmux the workspace is the headline and the worktree
                  name steps down beneath it, as on the home page's cards;
                  outside cmux the name is the full-size title. */}
              {/* With a resource selected, unreads only on, the diff
                  drill-down open or the details card off its Notes tab, the
                  titles are a way back to the worktree's whole overview: they
                  close the drill-down, deselect, as "← all resources" does,
                  turn unreads only off and return the card to Notes. A div
                  with role=button rather than a <button>, which may not hold
                  the headings. With none of those there is nothing to reset,
                  so it is plain text. */}
              <Stack
                gap={2}
                style={{ minWidth: 0 }}
                {...(resettable && {
                  role: "button",
                  tabIndex: 0,
                  title: narrowed ? "Show all resources" : "Show notes",
                  className: "detail-titles",
                  onClick: showOverview,
                  onKeyDown: (e: KeyboardEvent) => {
                    if (e.key !== "Enter" && e.key !== " ") return
                    e.preventDefault()
                    showOverview()
                  },
                })}
              >
                {/* The unread dot rides on the headline: the workspace when there is
                    one, else the worktree name. Static, unlike the logo:
                    these are this worktree's own unreads, which the logo
                    deliberately leaves out. */}
                <CmuxWorkspaceTitles path={path} unread={!!summary?.has_unread} />
                <Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
                  <Title
                    order={hasWorkspace ? 6 : 4}
                    c={hasWorkspace ? "dimmed" : undefined}
                    style={{ overflowWrap: "anywhere" }}
                  >
                    <WorktreeGlyph />
                    <span>{name}</span>
                  </Title>
                  {!hasWorkspace && summary?.has_unread && <UnreadMarkerDot label="worktree has unreads" />}
                  {summary && !summary.on_disk && <Badge size="xs" color="red">missing</Badge>}
                </Group>
              </Stack>
              {wide && cmuxButton}
              {wide && searchBar}
            </Group>
          </Group>
          {!wide && toolbar}
          {/* Pinned with the header only with room to spare; otherwise
              below it, scrolling away with the page. */}
          {!inDiff && !inColumn && pinCards && card}
        </Stack>
      </Box>
      {!inDiff && !inColumn && !pinCards && card}
      {/*
        No Overview/Slack tabs: a Slack thread is selected like any other
        resource and renders in ResourceDetailPane. The narrow-only
        Resources/Activity tabs are a different thing — see `overview`.
      */}
      {/*
        Deliberately no overflow and no height here. This used to be the page's
        scroller; now the document is, and any overflow value on this box would
        silently stop the header and list above from sticking.
      */}
      {inDiff ? (
        <DiffViewBoundary>
          <Suspense fallback={null}>
            <DiffView path={path} repo={summary?.repo} headerHeight={headerHeight} escHint={escDiff && !sidebarOpen} sidebarEscHint={escDiff && sidebarOpen} />
          </Suspense>
        </DiffViewBoundary>
      ) : (
        <Box style={{ display: "flex", flexDirection: "column" }}>
          {overview}
        </Box>
      )}
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
            void refreshResources()
          }}
        />
      )}
      {arrivalFollow !== null && (
        <AddResourceModal
          key={arrivalFollow.url}
          opened
          path={path}
          initialUrl={arrivalFollow.url}
          initialName={arrivalFollow.name}
          initialDescription={arrivalFollow.description}
          onClose={() => setArrivalFollow(null)}
          onAdded={() => {
            setArrivalFollow(null)
            void refreshResources()
          }}
        />
      )}
      {pendingFollowUrl !== null && (
        // Keyed by URL: the modal reads initialUrl at mount.
        <AddResourceModal
          key={pendingFollowUrl}
          opened
          path={path}
          initialUrl={pendingFollowUrl}
          defaultRelated
          onClose={() => setPendingFollowUrl(null)}
          onAdded={() => {
            setPendingFollowUrl(null)
            void refreshResources()
          }}
        />
      )}
      <EventDetailsModal
        e={openedEvent}
        onClose={() => setOpenedEvent(null)}
        resolveResource={resolveResource}
        path={path}
        onMakeTask={makeTaskFromEvent}
      />
    </Stack>
    </LinkedActionsContext.Provider>
    </ThreadActionsContext.Provider>
    </CrossHoverProvider></SearchContext.Provider></NarrowingContext.Provider>
  )
}
