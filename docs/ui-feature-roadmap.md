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

## Phase E (planned, not yet built)

- **Change a resource between Focus and Related from the detail card.** Show
  the current state in the summary card at the top of the resource detail
  view and let the user switch it — a `SegmentedControl` matching the one in
  `AddResourceModal`, so the control reads the same at add time and after.
  No confirmation step: changing the segment fires the request directly.

  **This needs backend work first — there is no API for it today.** The
  `related` flag can only be set when a resource is created:
  - `POST /api/worktree-resources/add` accepts `related`, and
    `resources.Add` honours it, but nothing changes it afterwards.
  - `internal/resources` has `loadPrimaryFlags` (read) with no setter, so a
    `SetPrimary(conn, worktreePath, resType, id, primary bool)` is needed to
    insert/delete the `worktree_primary` row.
  - Then a route (e.g. `POST /api/worktree-resources/primary` taking
    `{path, type, id, primary}`) alongside the existing add/remove pair in
    `registerAPI`.

  Good news on scope: `worktree_primary` is **worktree's own table**, not one
  of the watcher library's, so unlike Phase D this is entirely local — no
  library change, no release, no re-pin.

  Frontend notes:
  - The control belongs on `ResourceCard variant="detail"`, next to the
    remove control Phase C put there — the same "acts on the selected
    resource" cluster.
  - A Slack thread has no detail `ResourceCard` (Phase B), so as with the
    remove control it needs the same treatment via `ThreadView`'s
    `headerAction` slot, or that resource type silently can't be
    re-classified.
  - Refetch resources after the write so the Focus/Related sections in the
    list re-sort; the card's own state should follow the refetched data
    rather than being held locally, or the two can disagree.

## Fix round — DONE (2026-08-24): PR enrichment restored

Both symptoms had one root cause, and the hypothesis in the original note was
correct.

`FetchPRs` (`~/git/watcher/github/graphql.go`) batches every watched PR into a
single GraphQL query using aliases. GraphQL reports **partial success** — an
unresolvable repo comes back as a null alias while every other alias still
carries valid data — but the code returned early on `len(result.Errors) > 0`,
before parsing `result.Data` at all. `parseGraphQLResponse` compounded it,
failing the whole batch on a missing alias or a null `pullRequest`.

So one bogus subscription (`mturley/myrepo#42`, a repo that does not exist,
left over from handler-interop testing and subscribed by four worktrees)
meant **no PR was ever refreshed**. Existing cards served stale cached state;
newly added PRs got no state at all and rendered as a bare link — which is
exactly what `#9449` looked like.

Fixed in watcher **v0.6.1**: errors are held aside, the response is parsed,
and per-alias failures skip only that PR. An error is returned only when
nothing resolved, so a total failure still surfaces. The poller now names the
PRs that came back empty — skipping silently would have traded one invisible
failure for another.

Verified against the real database: a live poll enriched all five real PRs and
logged the bogus one by name; `#9449` went from no cached state to a real
title. The invalid subscriptions were removed **after** the fix, deliberately
— removing them first would have hidden the bug rather than fixing it.

## Card unification (queued — Phase E prep)

- **Consider replacing `ThreadView`'s `headerAction` slot with a conditional
  `ResourceCard`.** Phase C added `headerAction` so a Slack thread could
  carry a remove control despite having no detail `ResourceCard`; Phase E
  will need the same slot again for the Focus/Related control. Needing the
  slot twice is the signal that the seam is in the wrong place — a single
  card component that renders slack-specific content conditionally would let
  every detail-side control apply to every resource type for free.

  The real decision it forces: `ResourceCard` renders **cached**
  `watcher_resource_state`, while `ThreadView`'s header renders **live** data
  derived from the fetched thread (`deriveThreadMeta`, plus the
  first-message `fallbackTitle` for untitled threads). Those can disagree.
  Unifying means picking which source wins for a Slack card, and keeping the
  edit-details affordance wherever the header ends up.

## Phase F — DONE (2026-08-24): group names resolve for real

Superseded the config-mapping workaround by finding the endpoint Slack's own
web client uses (found via Playwright, confirmed by direct request outside the
browser):

```
POST https://edgeapi.slack.com/cache/<TEAM_OR_ENTERPRISE_ID>/usergroups/info
body: {"token":"<xoxc-…>","ids":["S…"],"enterprise_token":"<xoxc-…>"}
-> {"ok":true,"results":[{"id":"S…","handle":"…","name":"…","team_id":"T…"}]}
```

- watcher **v0.6.0** adds `Client.UserGroupsInfo(ctx, ids)`. It bypasses the
  shared `call()` helper deliberately: different host, JSON body, and the
  token travels in the body rather than as a bearer header. The team id for
  the URL path comes from `auth.test` and is cached on the client, so callers
  never have to know it.
- `internal/webui` resolves **only the ids a thread actually mentions**
  (`collectUserGroupIDs` gathers them from typed `usergroup` elements *and*
  raw `<!subteam^…>` mrkdwn, deduped), serving what it can from a per-Server
  cache and fetching only the remainder. A failed lookup still degrades to the
  `@group` placeholder rather than failing the thread.
- Hand-maintained config mappings are no longer needed. A config override to
  *relabel* a group would still be cheap if ever wanted — deferred.

## Cached-title mentions — DONE (2026-08-24)

The Slack `ResourceCard` title showed raw `<@U…>` / `<!subteam^S…>` for text
that resolved to names in the thread view. This was a **third render path**:
the card title is the cached `title` in `watcher_resource_state`, written by
the library's Slack poller, not rendered from a live thread.

It was not staleness — `threadTitle` never resolved mentions at all, so even
a fresh poll wrote raw tokens. `fallbacktitle.go` exists as a Go port of the
TS helper *specifically* so the cached title matches the live one; when the
live view learned to resolve mentions, the cached path silently diverged.

Fixed in watcher **v0.6.2**: `ResolveMentions` is the Go counterpart of
`ui/src/lib/resolveMentions.ts`, and the poller resolves the root text before
caching, fetching directories only for the ids the text references and only
those not already covered by the author lookup it does anyway.

**Debugging note worth keeping:** verification was confounded twice — first by
Go's test cache serving a stale "poll" that never ran (use `-count=1`), then
by the long-running `worktree ui` server re-polling every two minutes with an
older binary and overwriting the freshly-resolved titles. If cached state
appears not to update, check for a running server on an old binary before
suspecting the code.

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
