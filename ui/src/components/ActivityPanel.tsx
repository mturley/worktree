import { useCallback, useState, type CSSProperties, type ReactNode } from "react"
import { useLocation } from "wouter"
import { Group, Stack } from "@mantine/core"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { serializeResourceKey } from "../lib/resourceKey"
import { isArchivedEvent, openEventState } from "../lib/openEvent"
import { useGlobalTimeline } from "../hooks/useTimeline"
import { useActivityFilter } from "../hooks/useActivityFilter"
import { useAllResources } from "../hooks/useAllResources"
import { TimelineFeed } from "./TimelineFeed"
import { MarkAllReadButton } from "./MarkAllReadButton"
import { ArchivedToggle } from "./ArchivedToggle"
import { SourceFilter } from "./SourceFilter"
import { EventTypeFilter } from "./EventTypeFilter"
import { RefreshWatchersButton } from "./RefreshWatchersButton"
import { SearchSummary } from "./search/SearchSummary"
import { EventDetailsModal } from "./EventDetailsModal"
import { ChooseWorktreeModal } from "./ChooseWorktreeModal"
import { useMakeTaskFromEvent } from "./tasks/useMakeTask"
import { useTaskModal } from "./tasks/modal/TaskModalProvider"

/**
 * What clicking a feed row does. "route" (the home page): open the event's
 * resource in a worktree following it, asking which when several do.
 * "details" (the /mini page): open the event's details modal, for every row.
 */
export type EventSelectMode = "route" | "details"

/**
 * The event's resource as its row shows it, for the worktree picker's
 * heading — or the bare shape the event itself names, when it carries no
 * enriched one.
 */
function chosenResource(e: TimelineEvent): ResourceDTO {
  return e.resource ?? { type: e.resource_type, id: e.resource_id, url: e.resource_url, primary: false, title: e.resource_title }
}

/**
 * The global Activity feed — every worktree's events — with its controls,
 * filters and modals, for the home page and the /mini page to share. Like
 * useTasksPanel, it returns rendered pieces plus the state the page needs
 * around them, so each page lays them out its own way.
 */
export function useActivityPanel(opts: {
  unreadOnly: boolean
  /** Home page search; omitted on /mini. */
  search?: { terms: string[]; debouncedQ: string; queryText: string }
  /** "route" (home): a row opens its worktree, asking which when several follow it. "details" (mini): a row opens EventDetailsModal. */
  select: EventSelectMode
}): {
  controls: ReactNode
  render: (top?: ReactNode, headerStyle?: CSSProperties) => ReactNode
  modals: ReactNode
  events: TimelineEvent[]
  hasMore: boolean
  sources: string[]
  filtered: boolean
  clearFilters: () => void
  pickEvent: (e: TimelineEvent) => void
} {
  const { unreadOnly, search, select } = opts
  const [, navigate] = useLocation()
  // "Make task" from an event: the global feed has no worktree to act in.
  const makeTaskFromEvent = useMakeTaskFromEvent()
  // A task event's row opens its task, over this page.
  const { open: openTask } = useTaskModal()
  const [archived, setArchived] = useState(false)
  const { sources, setSources, categories, setCategories, eventTypes } = useActivityFilter()
  // The same cached query the Resources tab uses.
  const allResources = useAllResources()
  const tl = useGlobalTimeline(archived, sources, unreadOnly, eventTypes, search?.debouncedQ ?? "")
  // An archived event has no worktree to route to; picking one in the search
  // dropdown opens its details here instead.
  const [pickedEvent, setPickedEvent] = useState<TimelineEvent | null>(null)

  /**
   * Opens an event's resource from the global timeline, then its details.
   *
   * A resource has no meaning without a worktree here — the feed spans all of
   * them — so this routes to a worktree following it, which the event names
   * in worktree_paths. Rows are only clickable this way for events that have
   * one (canSelectResource), so there is always a destination.
   *
   * The event rides along in history state, and the worktree page opens its
   * details modal over the selected resource: clicking an entry is asking
   * about THAT entry, and landing on the resource alone left you to find it
   * again in the resource's feed.
   */
  const openEventIn = (path: string, e: TimelineEvent) => {
    navigate(`/worktree/${encodeURIComponent(path)}?resource=${serializeResourceKey({ type: e.resource_type, id: e.resource_id })}`, {
      state: openEventState(e),
    })
  }
  // An event several worktrees follow asks which one (ChooseWorktreeModal) —
  // from the feed, as a Resources row does, and from the search dropdown. The
  // choice carries the event along. (The home page keeps its own chooser for
  // resources picked in the search dropdown.)
  const [choosing, setChoosing] = useState<{ r: ResourceDTO; worktrees: { path: string; branch: string }[]; e: TimelineEvent } | null>(null)
  const selectEventResource = (_key: { type: string; id: string }, e: TimelineEvent) => {
    const paths = e.worktree_paths ?? []
    if (paths.length > 1) {
      setChoosing({ r: chosenResource(e), worktrees: paths.map((path, i) => ({ path, branch: e.worktrees[i] ?? "" })), e })
    } else if (paths[0]) openEventIn(paths[0], e)
  }

  const searching = (search?.terms.length ?? 0) > 0
  const searchOrUnread = searching || unreadOnly
  const eventNoun: [string, string] = unreadOnly ? ["unread event", "unread events"] : ["event", "events"]
  // The source toggles and the event types both narrow the feed.
  const filtered = sources.length > 0 || categories.length > 0
  // Clears the event types with it (useActivityFilter).
  const clearFilters = useCallback(() => setSources([]), [setSources])

  // The Activity tab's own controls: refresh and archived.
  const controls = (
    <Group gap="sm" wrap="nowrap" align="center" data-testid="activity-controls">
      <Group gap={6} wrap="nowrap" align="center">
        <RefreshWatchersButton />
        {/* Only over the whole feed, as on the worktree page. "Show
            archived" only adds to the feed, so it does not hide it. */}
        {!searching && !filtered && (
          <MarkAllReadButton
            resources={allResources.data ?? []}
            feed={{ showWorktrees: true }}
            taskScope={{ kind: "all" }}
          />
        )}
      </Group>
      <ArchivedToggle value={archived} onChange={setArchived} />
    </Group>
  )

  const render = (top?: ReactNode, headerStyle?: CSSProperties) => (
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
        {top ?? controls}
        <Group>
          <SourceFilter value={sources} onChange={setSources} />
        </Group>
        {/* Narrows only the feed, not the worktree cards: a card follows
            resources, and every resource has every kind of event. */}
        <EventTypeFilter sources={sources} value={categories} onChange={setCategories} />
        {/* Directly above the results it counts. Only once the feed holds
            the results for what is typed: during the debounce and the first
            fetch it would count the old ones. */}
        {(searchOrUnread || filtered) && (search?.debouncedQ ?? "") === (search?.queryText ?? "") && !tl.isLoading && (
          <SearchSummary count={tl.events.length} more={tl.hasMore} noun={eventNoun} filtered={filtered} />
        )}
      </Stack>
      <TimelineFeed
        events={tl.events}
        loading={tl.isLoading}
        error={tl.error}
        showWorktrees
        // Narrowed, the "0 … events" line above says it.
        emptyText={searchOrUnread || filtered ? null : undefined}
        hasMore={tl.hasMore}
        onLoadMore={tl.loadMore}
        loadingMore={tl.loadingMore}
        // In details mode no row selects its resource: every row falls back
        // to the feed's own details modal, and says "View event details",
        // not "… in worktree", since there is no worktree page to go to.
        onSelectResource={select === "details" ? undefined : selectEventResource}
        canSelectResource={select === "details" ? undefined : (e) => Boolean(e.worktree_paths?.length)}
        onMakeTask={makeTaskFromEvent}
        onOpenTask={openTask}
      />
    </Stack>
  )

  // An archived event (only with "Show archived" on) has no worktree to
  // route to; like its row, it opens the details modal, which offers to
  // follow the resource again. In details mode, every event does.
  const pickEvent = (e: TimelineEvent) => (select === "details" || isArchivedEvent(e) || !e.worktree_paths?.length
    ? setPickedEvent(e)
    : selectEventResource({ type: e.resource_type, id: e.resource_id }, e))

  const modals = (
    <>
      <EventDetailsModal e={pickedEvent} onClose={() => setPickedEvent(null)} onMakeTask={makeTaskFromEvent} />
      <ChooseWorktreeModal
        r={choosing?.r ?? null}
        worktrees={choosing?.worktrees ?? []}
        onPick={(path) => {
          const c = choosing
          setChoosing(null)
          if (c) openEventIn(path, c.e)
        }}
        onClose={() => setChoosing(null)}
      />
    </>
  )

  return {
    controls, render, modals, events: tl.events, hasMore: tl.hasMore,
    sources, filtered, clearFilters, pickEvent,
  }
}
