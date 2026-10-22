import { useEffect, useState } from "react"
import { Anchor, Box, Button, Center, Group, Stack, Tabs, Text } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { useWorktreeTimeline } from "../hooks/useTimeline"
import { useSearchQuery } from "../hooks/useSearchQuery"
import { SearchSummary } from "./search/SearchSummary"
import { filterLinkedSections } from "../lib/linkedSearch"
import { ResourceCard, type ResourceNotifyContext } from "./ResourceCard"
import { SlackThreadPane } from "./SlackThreadPane"
import { LinkPane } from "./LinkPane"
import { RefreshWatchersButton } from "./RefreshWatchersButton"
import { WatcherErrorMark } from "./WatcherErrorMark"
import { WatcherAlert } from "./WatcherAlert"
import { useWatcherStatus } from "../hooks/useWatchers"
import { useNow } from "../hooks/useNow"
import { relativeTime } from "../lib/relativeTime"
import { KeyHint } from "./search/KeyHint"
import { TimelineFeed } from "./TimelineFeed"
import { MarkAllReadButton } from "./MarkAllReadButton"
import { serviceName } from "./ResourceActions"
import { useLinkedResources } from "../hooks/useLinkedResources"
import { useResourceTab } from "../hooks/useSelectedResource"
import { UnreadMarkerDot } from "./UnreadMarkerDot"
import { pinnedStyle } from "../lib/stickyList"
import { LinkedResourcesPanel, LinkedTabControls, linkedTabLabel } from "./linked/LinkedResourcesPanel"
import { TASKS_TAB, useResourceTasksPlacement } from "./tasks/TasksSection"
import { useMakeTaskFromEvent } from "./tasks/useMakeTask"
import { useTaskModal } from "./tasks/modal/TaskModalProvider"

/** The PR/Jira pane's tabs, default first (see useResourceTab). */
const DETAIL_TABS = ["activity", "linked", TASKS_TAB] as const

interface ResourceDetailPaneProps {
  path: string
  resource: ResourceDTO
  /** Supplied only on narrow viewports, where this pane is a drilldown. */
  onBack?: () => void
  /** Show the Esc hint on the back link: Esc's next step is to deselect. */
  escHint?: boolean
  onRemoved?: () => void
  /** Refetch the worktree's resources (used after a Slack details save). */
  onResourceChanged?: () => void
  /** Height (px) of the page's sticky header, so a Slack thread's initial
   *  scroll can keep its unread divider below it. */
  topInset?: number
  /** Notification state for the card's switch; see ResourceNotifyContext. */
  notify?: ResourceNotifyContext
  /**
   * PR/Jira only: pin the resource card and its tab bar this far (px) from
   * the top of the viewport — the page header's height — so the activity or
   * linked resources scroll beneath them. Omitted, nothing is pinned.
   */
  stickyTop?: number
  /** Slack only: a message to bring into view; see ThreadView. */
  focus?: { ts: string; key: number }
}

/**
 * The PR/Jira body: a fuller summary of the resource above an activity feed
 * filtered to just that resource.
 *
 * Split into its own component so the timeline query is only issued for the
 * resource types that actually need it — a Slack thread must not fire a
 * filtered-timeline fetch it will never render.
 */
function TimelineBody({
  path,
  resource,
  onRemoved,
  onResourceChanged,
  notify,
  stickyTop,
}: {
  path: string
  resource: ResourceDTO
  onRemoved?: () => void
  onResourceChanged?: () => void
  notify?: ResourceNotifyContext
  stickyTop?: number
}) {
  const search = useSearchQuery()
  const { debouncedQ } = search
  const timeline = useWorktreeTimeline(path, { type: resource.type, id: resource.id }, [], false, [], debouncedQ)
  const makeTaskFromEvent = useMakeTaskFromEvent(path)
  // The tasks linking this resource put their events in its feed; a row of
  // one opens the task.
  const { open: openTask } = useTaskModal()
  const [urlTab, setTab] = useResourceTab(DETAIL_TABS)
  // A Tasks tab, or the list pinned between the card and the tab bar.
  const { tasks, shownTab: tab } = useResourceTasksPlacement(resource, urlTab, setTab, "activity")
  // Link titles are only fetched once the Linked tab has been shown — by a
  // click, or by arriving on it through the URL (back/forward, a refresh).
  const [linkedOpened, setLinkedOpened] = useState(tab === "linked")
  useEffect(() => {
    if (tab === "linked") setLinkedOpened(true)
  }, [tab])
  const linked = useLinkedResources(resource.type, resource.id, linkedOpened)
  const unreadCount = resource.unread_count ?? 0
  // This feed is one resource, so "updated" means the watcher for ITS type.
  const watcher = useWatcherStatus(resource.type)
  // Keeps "3m ago" moving without a per-second re-render of the whole pane.
  useNow(60_000)
  return (
    <Tabs
      value={tab}
      onChange={(v) => {
        if (v) setTab(v)
      }}
      // Only the Activity panel stays mounted while hidden (see its
      // keepMounted). The Linked panel remounts each time it is shown, so
      // the hierarchy's expand/collapse state starts fresh; the data comes
      // back from the query cache, so that costs no refetch.
      keepMounted={false}
    >
      {/*
        The card rides with the tab bar, inside Tabs, so the two can be
        pinned as one block whose sticky range is the whole pane, covering
        the page's gap above the column (see pinnedStyle).
      */}
      <Box
        style={stickyTop === undefined ? undefined : pinnedStyle(stickyTop, "var(--mantine-spacing-md)")}
        data-tooltip-layer={stickyTop === undefined ? undefined : "pinned"}
      >
        <ResourceCard
          r={resource}
          path={path}
          onRemoved={onRemoved}
          onMetaChanged={onResourceChanged}
          variant="detail"
          notify={notify}
        />
        {/* Pinned, the task list rides in this sticky block, between the
            card and the tab bar, so it stays in view with them. */}
        {tasks.pinnedPanel && <Box mt="sm">{tasks.pinnedPanel}</Box>}
        <Tabs.List mt="sm">
          <Tabs.Tab
            value="activity"
            rightSection={
              // Unread activity you can't see from the Linked tab.
              unreadCount > 0 && tab !== "activity" ? <UnreadMarkerDot label="unread activity" /> : undefined
            }
          >
            Activity
          </Tabs.Tab>
          <Tabs.Tab value="linked">
            {linkedTabLabel(linked.data, linked.data && filterLinkedSections(linked.data.sections, search.terms).count)}
          </Tabs.Tab>
          {tasks.tab}
          {/*
            The active tab's freshness and refresh, at the far end of the tab
            bar. For Activity this is where the source filter sits on the
            unified timelines; there is nothing to filter here — the feed is
            already one resource — so it carries the watcher's freshness.
          */}
          <Group gap={4} wrap="nowrap" align="center" ml="auto" style={{ flex: "none" }}>
            {tab === "activity" ? (
              <>
                {watcher?.last_success && (
                  <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                    {`Updated ${relativeTime(watcher.last_success)}`}
                  </Text>
                )}
                <WatcherErrorMark status={watcher} />
                <RefreshWatchersButton />
                {/* Only over the whole feed, as on the worktree's: searching,
                    it would clear events the search hides. */}
                {search.terms.length === 0 && (
                  <MarkAllReadButton
                    single
                    resources={[resource]}
                    feed={{ worktree: path, path, showResource: false }}
                  />
                )}
              </>
            ) : tab === "linked" ? (
              <LinkedTabControls query={linked} />
            ) : (
              tasks.toolbar
            )}
          </Group>
        </Tabs.List>
      </Box>
      <Tabs.Panel value="activity" pt="sm" keepMounted>
        <Stack gap="sm">
          {/* Directly above the results it counts, once the feed holds the
              results for what is typed (not mid-debounce). */}
          {search.terms.length > 0 && debouncedQ === search.q.trim() && !timeline.isLoading && (
            <SearchSummary
              count={timeline.events.length}
              more={timeline.hasMore}
              noun={["event", "events"]}
            />
          )}
          <TimelineFeed
            events={timeline.events}
            loading={timeline.isLoading}
            error={timeline.error}
            hasMore={timeline.hasMore}
            onLoadMore={timeline.loadMore}
            loadingMore={timeline.loadingMore}
            // Every event here belongs to the resource named in the card above,
            // so naming it again on each row says nothing.
            showResource={false}
            showUnreadDivider
            path={path}
            onMakeTask={makeTaskFromEvent}
            onOpenTask={openTask}
          />
          {/*
            The feed only holds what the poller captured for this worktree, which
            is never the resource's whole history. This is the way out to the rest
            of it, at the point where the reader has run out of events.
          */}
          {resource.url && serviceName(resource.type) && (
            <Center>
              <Button
                size="xs"
                variant="subtle"
                component="a"
                href={resource.url}
                target="_blank"
                rel="noreferrer"
              >
                More activity on {serviceName(resource.type)}
              </Button>
            </Center>
          )}
        </Stack>
      </Tabs.Panel>
      <Tabs.Panel value="linked" pt="sm">
        <LinkedResourcesPanel query={linked} path={path} />
      </Tabs.Panel>
      {!tasks.pinned && (
        <Tabs.Panel value={TASKS_TAB} pt="sm">
          {tasks.tabPanelBody}
        </Tabs.Panel>
      )}
    </Tabs>
  )
}

/**
 * The selected-resource pane. This is the swappable slot the design called
 * for: the surrounding shell (back control, responsive placement, selection
 * state) is identical for every resource type, and only the body differs —
 * a Slack thread renders in place of the filtered activity feed.
 */
export function ResourceDetailPane({
  path,
  resource,
  onBack,
  escHint,
  onRemoved,
  onResourceChanged,
  topInset,
  notify,
  stickyTop,
  focus,
}: ResourceDetailPaneProps) {
  return (
    <Stack gap="sm">
      {onBack && (
        // Styled as a link to match "← all worktrees", but a <button>
        // underneath: it deselects rather than navigating somewhere new.
        // Pinned, the card below pulls itself up by md over the gap above it
        // (see pinnedStyle), which is only the Stack's sm here — so pad the
        // row to md, or the opaque card clips the bottom of the Esc hint.
        <Group
          gap={6}
          wrap="nowrap"
          style={{
            alignSelf: "flex-start",
            ...(stickyTop !== undefined && { paddingBottom: "calc(var(--mantine-spacing-md) - var(--mantine-spacing-sm))" }),
          }}
        >
          <Anchor component="button" type="button" size="sm" onClick={onBack}>
            ← all resources
          </Anchor>
          {escHint && <KeyHint>Esc</KeyHint>}
        </Group>
      )}
      {/* Its service's watcher is off, or failing: say so, with a way to fix it. */}
      <WatcherAlert type={resource.type} />
      {resource.type === "slack" ? (
        <SlackThreadPane
          key={`${resource.type}:${resource.id}`}
          resource={resource}
          path={path}
          onRemoved={onRemoved}
          onResourceChanged={onResourceChanged}
          topInset={topInset}
          notify={notify}
          focus={focus}
        />
      ) : resource.type === "link" ? (
        <LinkPane
          resource={resource}
          path={path}
          onRemoved={onRemoved}
          onResourceChanged={onResourceChanged}
        />
      ) : (
        <TimelineBody
          key={`${resource.type}:${resource.id}`}
          path={path}
          resource={resource}
          onRemoved={onRemoved}
          onResourceChanged={onResourceChanged}
          notify={notify}
          stickyTop={stickyTop}
        />
      )}
    </Stack>
  )
}
