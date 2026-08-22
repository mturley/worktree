# Worktree UI feature roadmap

A running list of UI enhancements for `worktree ui` — things we want but have
deferred, with enough context to pick each one up later. Add to this as ideas
come up; move items to "Done" (or delete) when shipped.

## In progress / recently done

- **Add-resource modal with Focus/Related choice** — replaced the Overview
  tab's inline URL box (and the Slack tab's inline add box) with a shared
  `AddResourceModal` (`ui/src/components/AddResourceModal.tsx`) that prompts
  for Focus vs Related (→ `primary`/`related`) and, for Slack thread URLs,
  optional custom name/description. Reused by both the Overview `ResourceList`
  and the Slack tab `+` button.
- **Enriched Slack thread rail** — the per-worktree Slack tab's `NavLink` rail
  now shows per-thread metadata (author/channel, started/active timestamps,
  unread dot, first-message-preview fallback for untitled threads) via the
  `useTabMetas` hook, re-ported from the removed slack-mini `TabBar`.
- **Worktree cards with focus-resource lines** — `worktreeSummary` gained
  `focus_resources` (enriched primary resources), and a shared `WorktreeCard`
  component (used by both the home page's worktree list and the worktree
  detail page's header) renders a status icon + title/link per focus
  resource instead of bare counts. See `docs/web-ui-architecture.md`
  "Responsive resource selection".
- **Responsive tab bar (home page)** — `HomePage` now renders the worktree
  list and global timeline side by side on wide viewports, or as a
  "Worktrees"/"Timeline" `Tabs` pair on narrow ones, via the new
  `useIsWide()` hook (a single shared `(min-width: 48em)` predicate — see
  `docs/web-ui-architecture.md`).
- **Resource selection + filtered timeline** — clicking a resource card (on
  either the home page's worktree cards or the detail page's `ResourceList`)
  selects it via `useSelectedResource()`, stored in the URL as
  `?resource=<type>:<id>` (`GET /api/worktree-timeline` gained
  `resource_type`/`resource_id` filter params to match). The selected
  resource's `ResourceDetailPane` shows a fuller card plus an activity feed
  filtered to just that resource.
- **Responsive drilldown** — on narrow viewports, selecting a resource on
  the worktree detail page swaps the resource list for a full-width
  `ResourceDetailPane` drilldown with a back control, instead of showing
  both panes at once; the same `useSelectedResource()` state drives both the
  wide (side-by-side, highlighted card) and narrow (drilldown) presentations,
  so resizing mid-selection only changes layout, not what's selected.

## Phase B (planned, not yet built)

- **Slack restructure inside `ResourceDetailPane`.** `ResourceDetailPane`
  (`ui/src/components/ResourceDetailPane.tsx`) was deliberately built as a
  swappable slot: Phase B adds a `resource.type === "slack"` branch there
  that renders the Slack thread view (currently only reachable via the
  separate "Slack" tab) in place of the filtered timeline, so selecting a
  Slack resource from the Overview tab shows the thread directly. The
  surrounding responsive shell, selection state (`useSelectedResource`), and
  back control are already in place and should not need to change. See
  `docs/superpowers/specs/2026-08-21-worktree-ui-resource-selection-design.md`
  for the full design context.

## Deferred

- **Drag-to-reorder Slack threads in the rail.** The old slack-mini `TabBar`
  supported drag-to-reorder (dnd-kit `SortableContext` + a `reorderTabs`
  helper), persisting order in sessionStorage. When it was folded into the
  resource-scoped Slack tab, reorder was dropped because worktree resources
  have no persisted user-defined order.
  - **To do this:** add a resource-order concept persisted in **worktree's own
    DB** (not the watcher library's `watcher_subscriptions` etc. — resource
    ordering is a worktree-UI concern, not a watcher concern), expose it on the
    resource DTOs / a reorder endpoint, and re-add dnd-kit sorting to the rail.
  - Reference the removed `TabBar.tsx` / `state/tabs.ts#reorderTabs` in git
    history for the drag-reorder UI mechanics.

- **Pagination / "load more" in timelines.** The timeline API already supports
  `before`/`next_cursor`, but neither `HomePage` nor `WorktreeDetailPage` uses
  it — only the first page shows. Add infinite scroll / a load-more control.
  (See `docs/web-ui-architecture.md` "Known deferred items".)

- **Make `enrichEvent` cheaper (one join instead of ~3 queries per event).**
  `internal/webui/timeline.go`'s `enrichEvent` runs three DB queries for every
  event it renders: a `watcher_event_resources` lookup for the event's
  resource, then `resourceTitle` and `worktreesWatching`. A page of N events
  therefore costs roughly 3N queries.
  - **To do this:** collapse the per-row lookups into a single join over
    `watcher_events` + `watcher_event_resources` (+ cached resource state), or
    batch-prefetch the three pieces keyed by event id and enrich in memory.
  - The resource-filtered timeline added in the 2026-08-21 UI work already
    routes *around* this cost (it resolves matching event ids up front and
    enriches only the events it keeps), but the underlying per-event expense
    is unchanged. See
    `docs/superpowers/specs/2026-08-21-worktree-ui-resource-selection-design.md`.

- **Resource cards auto-refresh on SSE.** `useSSE` invalidates `["timeline"]`
  and `["worktrees"]` on `events_new` but not `["resources", path]`, so a
  detail page's resource cards don't refresh on new events without a
  poll-on-view remount. (See `docs/web-ui-architecture.md`.)
