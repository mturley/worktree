import { useEffect, useRef, useState } from "react"
import { Anchor, Box, Button, Collapse, Grid, Group, Stack, Title } from "@mantine/core"
import { Link, useRoute } from "wouter"
import { useWorktreeDetail } from "../hooks/useWorktreeDetail"
import { useSelectedResource } from "../hooks/useSelectedResource"
import { useIsWide } from "../hooks/useIsWide"
import { useWorktrees } from "../hooks/useWorktrees"
import { ResourceList } from "../components/ResourceList"
import { ResourceDetailPane } from "../components/ResourceDetailPane"
import { TimelineFeed } from "../components/TimelineFeed"
import { WorktreeDetailCard } from "../components/WorktreeDetailCard"
import { SourceFilter } from "../components/SourceFilter"
import { RefreshWatchersButton } from "../components/RefreshWatchersButton"
import { ThreadActionsContext } from "../components/slack/ThreadActionsContext"
import { AddResourceModal } from "../components/AddResourceModal"
import { parseThreadUrl } from "../lib/parseThreadUrl"

export function WorktreeDetailPage() {
  const [, params] = useRoute("/worktree/:path*")
  const rawPath = params?.["path*"]
  const path = rawPath ? decodeURIComponent(rawPath) : ""
  // Only applies to the unfiltered feed: selecting a resource already narrows
  // the timeline to that one resource, so the toggles are hidden there rather
  // than left as dead controls.
  const [sources, setSources] = useState<string[]>([])
  const { resources, timeline } = useWorktreeDetail(path, sources)
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
  // Open by default: the card is the page's identity, and a first visit that
  // hides it would look broken. Per page visit, not persisted — see the
  // toggle's comment.
  const [detailsOpen, setDetailsOpen] = useState(true)

  // The sticky resource list has to start below the header, and the header's
  // height is not a constant: the branch name wraps, the cmux workspace strip
  // comes and goes, and the Hide/Show details toggle swings it by the whole
  // summary card. A hardcoded offset would leave the list overlapping the
  // header or floating below it, so measure the real thing.
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = useState(0)
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
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap={6} wrap="nowrap" align="center">
          <Title order={5}>Activity</Title>
          <RefreshWatchersButton />
        </Group>
        <SourceFilter value={sources} onChange={setSources} />
      </Group>
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

  // Nothing selected: full-width resources with the timeline stacked below —
  // the same shape at every width, so narrow is no longer a lesser view that
  // silently drops the timeline.
  const stacked = !selectedResource
  // Side by side, the resource list stays put while the page scrolls past it.
  //
  // alignSelf is load-bearing: a Grid column stretches to the row's height by
  // default, and an element as tall as its scroll container can never stick.
  // maxHeight + overflowY are the fallback for a list longer than the screen —
  // it scrolls itself only when it has to, rather than always.
  const listSticky = stacked
    ? undefined
    : {
        position: "sticky" as const,
        top: headerHeight,
        // Above the flowing column beside it, for the same reason the header
        // needs a real value: card internals carry small z-indexes of their
        // own and would otherwise paint over this list as it scrolls past.
        zIndex: 1,
        alignSelf: "flex-start" as const,
        maxHeight: `calc(100dvh - ${headerHeight}px)`,
        overflowY: "auto" as const,
      }

  // Narrow + a selection is the one layout that drills down, replacing the
  // list outright — there is no room to keep a navigator beside the resource.
  // Every other combination is the Grid below, which differs only in its
  // spans. Both branches read the same selection state, so resizing swaps
  // presentation without disturbing what is selected.
  const overview = selectedResource && !wide ? (
    <ResourceDetailPane
      path={path}
      resource={selectedResource}
      onBack={clear}
      onRemoved={resources.refetch}
      onResourceChanged={resources.refetch}
    />
  ) : (
    // One Grid in both states, deliberately. Swapping the wide layout between
    // a Grid and a stacked Box would put `list` at a different position in the
    // React tree, remounting it on every selection change — losing its scroll
    // position and flickering. Changing only the SPANS keeps it mounted.
    //
    // With nothing selected the columns go full width, so the resources fill
    // the page and the cross-resource timeline wraps beneath them — nothing to
    // stick beside, so the list is not sticky in that state either.
    <Grid
      gutter="md"
      // No overflow here on purpose. Mantine's Grid inner carries negative
      // margins to offset the columns' padding, so making the Grid a scroll
      // container exposes those as HORIZONTAL overflow — a stray sideways
      // scrollbar. When stacked, the page-level Box below scrolls instead.
      style={{ margin: 0 }}
    >
      <Grid.Col span={stacked ? 12 : 4} style={listSticky}>{list}</Grid.Col>
      {/* No scroller: this column's content is what the PAGE scrolls. */}
      <Grid.Col span={stacked ? 12 : 8}>
        {selectedResource ? (
          <ResourceDetailPane
            path={path}
            resource={selectedResource}
            // Also on wide: deselecting is how you get the worktree's
            // cross-resource timeline back, and it was previously only
            // reachable by clicking the selected card again.
            onBack={clear}
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
    */}
    <Stack p="md" gap="md">
      <Box
        ref={headerRef}
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
          background: "var(--mantine-color-body)",
        }}
      >
        <Stack gap="md">
          <Group justify="space-between" wrap="nowrap" align="center">
            <Group wrap="nowrap" style={{ minWidth: 0 }}>
              <Anchor component={Link} href="/">← all worktrees</Anchor>
              <Title order={4} style={{ overflowWrap: "anywhere" }}>{branch}</Title>
            </Group>
            {/*
              The header is fixed and the body scrolls beneath it, so the
              summary card costs the resource list and timeline the same space
              on every scroll position. Hiding it is the cheapest way to get
              that space back on a short screen.
            */}
            {summary && (
              <Button
                size="compact-sm"
                variant="subtle"
                onClick={() => setDetailsOpen((o) => !o)}
                aria-expanded={detailsOpen}
                style={{ flex: "none" }}
              >
                {detailsOpen ? "Hide details" : "Show details"}
              </Button>
            )}
          </Group>
          {summary && (
            <Collapse in={detailsOpen}>
              <WorktreeDetailCard w={summary} />
            </Collapse>
          )}
        </Stack>
      </Box>
      {/*
        No Overview/Slack tabs: a Slack thread is selected like any other
        resource and renders in ResourceDetailPane, so the resource list plus
        that pane is the whole page body.

        Wide: the Grid below manages its own per-column scrolling. Narrow:
        everything collapses into this single scroller.
      */}
      {/*
        Deliberately no overflow and no height here. This used to be the page's
        scroller; now the document is, and any overflow value on this box would
        silently stop the header and list above from sticking.
      */}
      <Box style={{ display: "flex", flexDirection: "column" }}>
        {overview}
      </Box>
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
