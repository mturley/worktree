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

## Phase D — DONE (2026-08-24)

- **Mention pills.** `components/slack/Mention.tsx` renders a mention as a
  dark-blue chip with light-blue text, used by BOTH render paths
  (`RichText.tsx` for typed blocks, `lib/mrkdwn.tsx` for the string fallback)
  so a mention looks the same however the message arrived. Covers user, group
  and broadcast mentions.
- **User mentions resolve in the fallback title.** `lib/resolveMentions.ts`
  rewrites mention tokens in a raw string, and `ThreadView` runs it *before*
  `fallbackTitle` truncates — so an untitled thread shows names, and the
  60-char budget is spent on resolved text rather than raw ids sliced
  mid-token.
- **Group mentions resolve to names** (watcher **v0.5.0**). The blocker was
  data, not rendering: Slack keys a `usergroup` element `usergroup_id` and a
  `broadcast` element `range`, but the library's `rawElement` mapped only
  `name`, so both arrived empty. v0.5.0 adds `Element.UserGroupID` /
  `Element.Range` and `Client.UserGroups(ctx)` (`usergroups.list`).
  `Server.userGroups` caches the directory exactly as `Server.emoji` does and
  attaches it to `ThreadResponse`; `Mention` resolves ids through a React
  context (`SlackGroupsContext`) rather than drilling a `groups` prop through
  every render function. Resolution order is handle → name → bare id, never a
  generic word.
- **Bug found and fixed en route:** every broadcast rendered as `@here`,
  including `@channel` and `@everyone`, because the code fell back to `'here'`
  when the (always-empty) `Name` was blank. No fixture covered `usergroup` or
  `broadcast` elements, which is why it went unnoticed; both now have
  regression tests.

**Outcome on this workspace: group names are NOT resolvable, and we stopped
short of making them so.** Verified live: `usergroups.list` is callable with a
session token but returns an empty list for an org-level Enterprise Grid
token, and the `team_id` it wants is a workspace `T…` id while `auth.test`
reports the enterprise `E…` id (which it rejects as `invalid_arguments`).
Resolving would mean discovering member-workspace ids and merging per-workspace
calls — judged too hacky for the payoff. The plumbing stays (it works on
non-Grid workspaces and costs nothing); unresolved groups render as a readable
`@group` with the subteam id in the title attribute. Full probe results are in
`docs/reverse-engineering/slack-web-api.md`.

**Not threaded everywhere:** `groups` reaches mentions via context from
`ThreadView`, so mentions inside attachments/Block Kit rendered outside that
provider still fall back. Cheap to extend if it shows up in practice.

**Still outstanding — the cached card title (a third render path).** The Slack
`ResourceCard` in the resource list shows raw ids for BOTH user and group
mentions. That title does not come from `ThreadView` at all: it is the cached
`title` in `watcher_resource_state`, written by the library's Slack poller
(`~/git/watcher/slack/fallbacktitle.go`), which builds it from raw message
text with no user/group directory to hand. Fixing it means resolving mentions
at poll time in the library — the poller would need to fetch the users
referenced by the first message — so it is cross-repo work and was not
attempted here. User mentions ARE resolvable there (unlike groups), so this
is worth doing on its own merits.

## Phase E — DONE (2026-08-25): switch a resource between Focus and Related

A `SegmentedControl` on the detail card, matching `AddResourceModal`'s, so the
control reads the same at add time and after. Changing it fires the request
directly — no confirmation for a one-click, reversible reclassification.

Backend first, because there was no API: the `related` flag could only be set
at creation, so changing your mind meant removing and re-adding a resource and
losing its custom metadata along the way.

- `resources.SetPrimary(conn, worktreePath, resType, id, primary)` flips the
  `worktree_primary` row in place. It **errors on an untracked resource**
  rather than inserting one — a no-op reporting success would look in the UI
  exactly like a change that stuck.
- `POST /api/worktree-resources/primary` `{path, type, id, primary}` → 204,
  registered alongside the existing add/remove pair.
- Entirely local: `worktree_primary` is worktree's own table, so no library
  change, release, or re-pin.

Frontend: the control sits at the bottom-right of the detail card, **left of
the open/copy group** — reclassifying is about this worktree, opening is about
the resource itself. The card refetches on success so the Focus/Related
sections in the list re-sort immediately, and surfaces a failure inline rather
than silently reverting.

**Cheaper than when it was queued:** the note then said a Slack thread would
need `ThreadView`'s `headerAction` slot again, since it had no detail card.
Card unification removed that problem — Slack threads get this for free.

## Jira issue-type icons (in progress)

Replace the single generic Jira icon with the per-issue-type icons Jira itself
serves (Bug, Task, Story, Epic, Spike…).

**Known already:** the watcher Jira client parses `issuetype` but keeps only
`Name` (`~/git/watcher/jira/client.go`), and the poller caches
`"issue_type": <name>`. So there is no icon URL anywhere in our data today —
capturing `issuetype.iconUrl` is a **library** change before any UI work.

**Binding constraint (2026-08-25):** if agent-handler already implements this,
the shared part belongs in `github.com/mturley/watcher`, consumed by BOTH
handler and worktree — not copy-pasted into worktree. Handler should be
migrated onto the library version in the same effort rather than left with a
duplicate. This follows the repo's own rule that the library is the single
home for source/poller behaviour.

**Reuse, do not reinvent:** worktree already proxies Slack images through
`internal/webui/image_proxy.go` + `slack_proxy.go`, with SSRF protection
(refusing loopback, RFC1918, link-local incl. the cloud-metadata address) and
an 8 MiB cap. A Jira icon proxy — if auth means the browser cannot fetch the
URL directly — should reuse that machinery rather than write a second proxy
with its own security thinking.

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
