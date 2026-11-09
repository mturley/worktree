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
import { UnreadOnlyToggle } from "./UnreadOnlyToggle"
import { HumansOnlyToggle } from "./HumansOnlyToggle"
import { ActivityToggles } from "./ActivityToggles"
import { useHumansOnly } from "../hooks/useHumansOnly"
import { SourceFilter } from "./SourceFilter"
import { EventTypeFilter } from "./EventTypeFilter"
import { RefreshWatchersButton } from "./RefreshWatchersButton"
import { SearchSummary } from "./search/SearchSummary"
import { EventDetailsModal } from "./EventDetailsModal"
import { useEventFromUrl } from "../hooks/useEventFromUrl"
import { ChooseWorktreeModal } from "./ChooseWorktreeModal"
import { useMakeTaskFromEvent } from "./tasks/useMakeTask"
import { useTaskModal } from "./tasks/modal/TaskModalProvider"
import type { TaskPick } from "./search/suggestions"

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
  setUnreadOnly: (v: boolean) => void
  /** Whether anything is unread, for the Unreads only switch's thumb. */
  hasUnread: boolean
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
  pickTask: (pick: TaskPick) => void
} {
  const { unreadOnly, setUnreadOnly, hasUnread, search, select } = opts
  const [, navigate] = useLocation()
  // "Make task" from an event: the global feed has no worktree to act in.
  const makeTaskFromEvent = useMakeTaskFromEvent()
  // A task event's row opens its task, over this page.
  const { open: openTask } = useTaskModal()
  const [archived, setArchived] = useState(false)
  const [humansOnly, setHumansOnly] = useHumansOnly()
  const { sources, setSources, categories, setCategories, eventTypes } = useActivityFilter()
  // The same cached query the Resources tab uses.
  const allResources = useAllResources()
  const tl = useGlobalTimeline(archived, sources, unreadOnly, eventTypes, search?.debouncedQ ?? "", humansOnly)
  // An archived event has no worktree to route to; picking one in the search
  // dropdown opens its details here instead.
  const [pickedEvent, setPickedEvent] = useState<TimelineEvent | null>(null)
  // A link's event, here only with no worktree to open it over. Not in the
  // mini view, whose links lead out of it.
  useEventFromUrl(setPickedEvent, select === "route")

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
  const [choosing, setChoosing] = useState<{
    r: ResourceDTO
    taskTitle?: string
    worktrees: { path: string; branch: string }[]
    open: (path: string) => void
  } | null>(null)
  const selectEventResource = (_key: { type: string; id: string }, e: TimelineEvent) => {
    const paths = e.worktree_paths ?? []
    if (paths.length > 1) {
      setChoosing({
        r: chosenResource(e),
        worktrees: paths.map((path, i) => ({ path, branch: e.worktrees[i] ?? "" })),
        open: (path) => openEventIn(path, e),
      })
    } else if (paths[0]) openEventIn(paths[0], e)
  }
  // A task goes to its worktree as an event does, and opens there: its modal
  // lives in the URL, so there is nothing to carry along. One with no worktree
  // (a global or archived one) has nowhere to go, so it opens over this page.
  // So does every task in details mode.
  const pickTask = ({ id, title, paths }: TaskPick) => {
    const openIn = (path: string) => navigate(`/worktree/${encodeURIComponent(path)}?task=${id}`)
    if (select === "details" || paths.length === 0) openTask(id)
    else if (paths.length === 1) openIn(paths[0])
    else {
      setChoosing({
        r: { type: "task", id: String(id), primary: false, title } as ResourceDTO,
        taskTitle: title,
        worktrees: paths.map((path) => ({ path, branch: "" })),
        open: openIn,
      })
    }
  }

  const searching = (search?.terms.length ?? 0) > 0
  const searchOrUnread = searching || unreadOnly
  const eventNoun: [string, string] = unreadOnly ? ["unread event", "unread events"] : ["event", "events"]
  // The source toggles, the event types and Humans only all narrow the feed.
  const filtered = sources.length > 0 || categories.length > 0 || humansOnly
  // Clears the event types with it (useActivityFilter).
  const clearFilters = useCallback(() => {
    setSources([])
    setHumansOnly(false)
  }, [setSources, setHumansOnly])

  // The Activity tab's own controls: refresh and mark all read.
  const controls = (
    <Group gap="sm" wrap="nowrap" align="center" data-testid="activity-controls">
      <Group gap={6} wrap="nowrap" align="center">
        <RefreshWatchersButton />
        {/* Only over the whole feed, as on the worktree page. "Include
            archived" only adds to the feed, so it does not hide it. */}
        {!searching && !filtered && (
          <MarkAllReadButton
            resources={allResources.data ?? []}
            feed={{ showWorktrees: true }}
            taskScope={{ kind: "all" }}
          />
        )}
      </Group>
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
        <ActivityToggles>
          <UnreadOnlyToggle value={unreadOnly} onChange={setUnreadOnly} hasUnread={hasUnread} />
          <HumansOnlyToggle value={humansOnly} onChange={setHumansOnly} />
          <ArchivedToggle value={archived} onChange={setArchived} />
        </ActivityToggles>
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
        // In details mode no row selects its resource: every row opens this
        // panel's details modal (so the page can tell it is open), and says
        // "View event details", not "… in worktree", since there is no
        // worktree page to go to.
        onOpenEvent={select === "details" ? setPickedEvent : undefined}
        onSelectResource={select === "details" ? undefined : selectEventResource}
        canSelectResource={select === "details" ? undefined : (e) => Boolean(e.worktree_paths?.length)}
        onMakeTask={makeTaskFromEvent}
        onOpenTask={(id, e) => pickTask({ id, title: e.resource_title, paths: e.worktree_paths ?? [] })}
      />
    </Stack>
  )

  // An archived event (only with "Include archived" on) has no worktree to
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
        taskTitle={choosing?.taskTitle}
        worktrees={choosing?.worktrees ?? []}
        onPick={(path) => {
          const c = choosing
          setChoosing(null)
          c?.open(path)
        }}
        onClose={() => setChoosing(null)}
      />
    </>
  )

  return {
    controls, render, modals, events: tl.events, hasMore: tl.hasMore,
    sources, filtered, clearFilters, pickEvent, pickTask,
  }
}
