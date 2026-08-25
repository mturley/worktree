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

## Jira issue-type icons — DONE (2026-08-25)

Jira serves a distinct icon per issue type (Bug, Task, Story, Epic, Spike…);
we now show it in place of the single generic ticket glyph, everywhere the
shared `ResourceStatusIcon` renders.

**No handler code to share, as it turned out.** The binding constraint below
assumed agent-handler already did this. It doesn't — it *removed* the
capability (commits `6ef1530`, `9135ce7`, 2026-08-04) because Jira's icon URLs
sit behind the same Basic auth as its REST API and 401 in a browser `<img>`,
and it now uses bundled `lucide-react` icons keyed by issue-type name. So
there was no duplicate to collapse; the shareable layer is the *data*, which
is where the change went.

- **watcher v0.7.0** — `jira.IssueData` gained `IssueTypeID` and
  `IssueTypeIconURL`, and `buildJiraStateJSON` caches `issue_type_id` /
  `issue_type_icon_url`. Both consumers re-pinned. Handler keeps its bundled
  icons for now; the field is there if it ever wants the real ones.
- **`GET /api/jira-icon?url=…`** re-attaches Basic auth server-side, which
  also keeps the API token out of the page. It reuses the existing image
  proxy rather than adding a second one: `handleImageProxy` was generalised
  to `handleImageProxyAuth(allowedHost, authorize func(*http.Request))`, so
  host pinning, the SSRF-safe transport and the no-redirect policy are shared
  and the only per-scheme part is the credential. The allowed host is derived
  from the configured Jira host, so a state row carrying some other host's
  URL cannot make us fetch it.
- **Fallback is real, not decorative.** `ResourceStatusIcon` renders the
  proxied `<img>` only when a URL was cached, and drops to the tabler icon on
  `onError` — unconfigured credentials, an expired token or an offline Jira
  degrade to the old appearance instead of a broken image.

**Ruling:** `issue_type_id` is cached in the library but NOT surfaced on
`resourceDTO`. The plan had it for cache-keying; the icon URL already
contains the avatar id, so the proxy caches on the URL via `Cache-Control`
and the id would have been an unused field.

## Compound button dividers — FIXED (2026-08-25)

The segments of `Button.Group` controls ("Open on GitHub | copy") ran
together with no divider, despite an earlier fix claiming otherwise.

**Root cause:** the rule keyed off `data-position="center|right"`. Mantine 7
emits no such attribute — `ButtonGroup` sets `data-orientation` on the *group*
and nothing on the children — so the selector matched nothing. Mantine's own
separation works by halving the border *width* between grouped children,
which does nothing for our `variant="light"` buttons: they have no border to
halve.

**Fix:** a `.compound-group` class on each group, drawing the divider as a
pseudo-element. Not a border — Mantine's border-width rules for grouped
children are more specific than anything reasonable we could write, and would
keep winning. Applied to all three compound controls (`ResourceActions`, the
Slack `ActionBar`, and the thread-unfurl group in `Attachments`).

## Thread unfurl "Add thread…" opens the add modal — DONE (2026-08-25)

The unfurl's Add button added the thread outright, which silently defaulted
the two things that add-time actually decides: Focus vs Related, and the
custom name/description. Both then had to be corrected on the resource card.

It now opens `AddResourceModal` pre-filled with the thread URL (new
`initialUrl` prop, read at mount — the page keys the modal by URL so a stale
instance cannot show the previous thread's link). The context action was
renamed `addThread` → `requestAddThread` to match what it does; the page owns
the modal because it is the only layer holding the worktree path. "Go to
thread" for already-tracked threads is unchanged.

## Resource cards refresh on SSE — FIXED (2026-08-25)

`useSSE` invalidated `["timeline"]` and `["worktrees"]` but not
`["resources", path]`, so a detail page's resource cards kept showing stale
cached state after an event arrived — the surface where staleness is most
visible, since the cards show exactly what the event just changed. Now
invalidates the `["resources"]` prefix, which matches every path's key.

## Deferred

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
