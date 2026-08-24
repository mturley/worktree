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
- **Resource selection + filtered timeline** — clicking a resource card in
  the worktree detail page's `ResourceList` selects it via
  `useSelectedResource()` (this is a detail-page-only concern; a
  `FocusResourceLine` on a home-page worktree card is just an external link
  to the resource, not a selection affordance), stored in the URL as
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

## Phase B — DONE (2026-08-24)

- **Slack threads folded into resource selection.** `ResourceDetailPane` now
  branches on `resource.type === "slack"` and renders the thread
  (`SlackThreadPane`) where a PR/Jira resource shows its filtered activity
  feed. The Overview/Slack `Tabs` and the whole thread rail are gone: a Slack
  thread is selected like any other resource, and the responsive drilldown
  works on it unchanged. `SlackTab`, `ThreadRailLabel`, `useTabMetas` and
  `useWorktreeSlackThreads` were deleted as orphans.

## Phase C — DONE (2026-08-24)

- **Remove control moved to the detail side, Slack thread header carded.**
  - `RemoveControl` now renders only for `ResourceCard variant="detail"`, so
    the selectable cards in the resource list no longer carry a `×`.
  - `ThreadView`'s existing title/description/author/channel/timestamps block
    is wrapped in a `Paper` matching the PR/Jira detail card — the header was
    restyled as a card, not duplicated by adding a second one above it. The
    edit-details affordance is unchanged.
  - `ThreadView` gained a `headerAction` slot; `SlackThreadPane` injects the
    shared `RemoveControl` into it, so a Slack thread stays removable despite
    having no detail `ResourceCard` of its own.
  - The old "removing must not also select" guard is now moot by
    construction: the two controls can no longer appear on the same card.

## Phase D (planned, not yet built)

- **Resolve Slack user-group mentions to their names.** A group mention
  currently degrades to a generic placeholder when Slack doesn't inline a
  label, so a message reads `@subteam` / `@usergroup` instead of naming the
  group. User mentions already resolve properly, and this should follow the
  same shape.

  Where it happens today:
  - `ui/src/lib/mrkdwn.tsx:154-165` — `<!subteam^S123|@handle>` uses the
    piped label when present (fine), but a bare `<!subteam^S123>` falls
    through to the literal string `@subteam`.
  - `ui/src/components/slack/RichText.tsx:50-51` — a typed `usergroup`
    element renders `@{el.Name || 'usergroup'}`, so it shows `@usergroup`
    whenever the block carries no name.

  The model to copy is user mentions: `renderAngleToken` takes a
  `users: Record<string, User>` map and looks the id up
  (`mrkdwn.tsx:147-152`), falling back to the raw id — never to a generic
  word. Groups need the equivalent `groups: Record<string, UserGroup>` map
  threaded to both renderers, with the raw id as the fallback so an
  unresolved group is still identifiable.

  **This is cross-repo work.** The Slack client and its domain types live in
  `github.com/mturley/watcher/slack`, not here, so per `.claude/CLAUDE.md`
  the sequence is: add the group lookup (Slack's `usergroups.list`) and a
  `UserGroup` domain type in `~/git/watcher`, with tests and synthetic
  fixtures; cut a release tag; re-pin here; then surface the map on
  `ThreadResponse` (alongside the existing `users` and `emoji` maps) and
  consume it in the two renderers above.

  Also update `docs/reverse-engineering/slack-web-api.md` in the same change
  with whatever the endpoint's real payload shape turns out to be — that doc
  is treated as part of the deliverable, and group listing isn't covered yet.

  Worth noting for scope: because the piped-label case already works, this
  only changes rendering for group mentions Slack sends without an inline
  label. Confirm how common that is before investing in caching or a poll
  loop for the group list.

- **Fix user mentions in the fallback title too.** The same inconsistency
  exists for *user* pings, and it is arguably more visible: an untitled
  thread's fallback title shows raw ids even though the identical text
  resolves to names in the message body.

  `ThreadView.tsx:260` does
  `fallbackTitle(data?.messages[0]?.Text) || '(no title)'` — it passes the
  **raw** message text, which still contains `<@U123>` / `<!subteam^S123>`
  tokens. `lib/fallbackTitle.ts` is a pure string helper (collapse
  whitespace, truncate to 60 chars) with no access to the `users` map, so
  the ids survive verbatim while `renderAngleToken` resolves the very same
  tokens in the body.

  Two wrinkles to plan for:
  - `fallbackTitle` returns a **string** because it is used as a title, so
    mention resolution there means substituting names into the string rather
    than returning nodes. The styled pill treatment below therefore does not
    apply to the title — plain resolved names are the right output.
  - Substitute **before** truncating. Truncating first would cut raw ids
    mid-token and produce nonsense; the 60-char budget should be spent on
    the resolved text the reader actually sees.

- **Style mentions like Slack does.** Both user and group mentions should
  render as a pill — dark blue background, light blue text — rather than as
  plain inline text. Applies to both render paths (`RichText.tsx` for typed
  blocks, `lib/mrkdwn.tsx` for the mrkdwn-string fallback), so the treatment
  belongs in one shared component both call rather than duplicated styling.
  Use Mantine theme tokens so it tracks light/dark; note the app defaults to
  dark. Broadcast mentions (`@here` / `@channel` / `@everyone`) should be
  considered at the same time — Slack styles those as pills too, and they
  flow through the same code paths.

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

- **Unread indicator for Slack threads.** The removed thread rail showed an
  unread dot per thread, driven by `useTabMetas` fetching `/api/thread` for
  every open thread on a 30s interval. Phase B dropped it rather than keep
  that fan-out alive for every Slack resource in a list. To restore it, the
  cheap path is to have the watcher Slack poller record unread state in
  `watcher_resource_state` (it already writes channel/author/timestamps
  there), so the Slack `ResourceCard` can show it with no extra fetches.

- **Resource cards auto-refresh on SSE.** `useSSE` invalidates `["timeline"]`
  and `["worktrees"]` on `events_new` but not `["resources", path]`, so a
  detail page's resource cards don't refresh on new events without a
  poll-on-view remount. (See `docs/web-ui-architecture.md`.)
