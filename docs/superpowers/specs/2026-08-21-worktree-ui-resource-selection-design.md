# Worktree UI: worktree cards, resource selection, and responsive drilldown

**Date:** 2026-08-21
**Status:** Approved design; Phase A ready to plan
**Branch:** `wt-ui-fixes` (local iteration only — no PRs, no remote pushes)

## Context

`worktree ui` today has two pages:

- **HomePage** — a `NavLink` list of worktrees beside a global timeline, in a
  `Grid` that stacks vertically on narrow viewports.
- **WorktreeDetailPage** — Overview/Slack tabs; Overview is a resource list
  beside an unfiltered worktree timeline.

Three weaknesses motivate this work:

1. On narrow viewports the two columns stack, so the timeline pushes the
   worktree list far off-screen instead of offering a way to switch between
   them.
2. The worktree list shows only aggregate counts ("2 PRs, 3 Jira issues"). It
   never shows *which* resources a worktree is about, so the list is not
   useful for orientation.
3. The worktree timeline is unfiltered. With several resources per worktree,
   finding "what happened on this PR" means visually scanning a mixed feed.

This design restructures both pages around a **worktree card** and a
**selected resource**, and makes the selected-resource area a swappable pane
so that Phase B can render a Slack thread there.

## Scope

**Phase A** (planned and built first):

1. Responsive tab bar on HomePage (Worktrees | Timeline) when narrow.
2. Worktree cards on HomePage, listing each focus resource with a status icon
   and link.
3. The same card reused at the top of WorktreeDetailPage.
4. Selectable resource cards on the detail page; selection filters the
   timeline and shows a detailed resource summary above it.
5. On narrow viewports, selection presents as a drilldown sub-page with an
   "all resources for worktree" back control — backed by the *same* state as
   the wide-viewport selection.

**Phase B** (designed here, built after Phase A lands):

6. Replace the Overview/Slack tabs and the Slack thread rail with the
   selected-resource pattern: selecting a Slack resource renders the thread in
   the pane instead of a filtered timeline.

## Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Timeline filtering | **Server-side**, new query params | Correct even when a resource's events fall outside the unfiltered page limit. Client-side filtering of an already-limited page silently under-reports. |
| Selection state | **URL query param** `?resource=<type>:<id>` | Deep-linkable, survives refresh, browser back deselects. |
| Focus resources per card | **All of them** | Simplest and complete; worktrees have few focus resources in practice. |
| Status icons | **Add `@tabler/icons-react`** | Mantine's companion set; real PR/merge glyphs; tree-shaken. |
| Responsive structure | **Presentation-only responsiveness** over one selection state | Resizing the viewport must not change the URL or the selection — only the layout. |
| Build order | Design 1–6 together; build 1–5, then 6 | Phase B is destructive (removes tabs + rail); safer once the new pattern has been used. |

### Rejected: route-based drilldown

Making the narrow drilldown its own route
(`/worktree/:path/resource/:type/:id`) was considered and rejected. Selection
must be identical across a viewport resize; with a route-based drilldown a
resize would have to rewrite the URL to preserve selection, which is precisely
the coupling this design avoids.

## Architecture

### 1. Backend (`internal/webui`) — two additive changes

Both are local to `webui`. Neither needs a watcher-library change, so this is
**not** cross-repo work.

**1a. `worktreeSummary.focus_resources`**

`handleWorktrees` already loads every worktree's resources via
`resources.Load` to compute counts. Extend the same loop to collect the
primary ones:

```go
type worktreeSummary struct {
    // ...existing fields unchanged...
    FocusResources []resourceDTO `json:"focus_resources"`
}
```

For each `res` where `!res.Related`, build a `resourceDTO` exactly as
`handleWorktreeResources` does (including `CustomName`/`CustomDescription`)
and call the existing `s.enrichResourceDTO(&dto)`. Existing count fields are
untouched, so nothing that reads them breaks.

Initialize the slice with `make([]resourceDTO, 0, ...)` — matching the
existing style in `handleWorktreeResources` — so a worktree with no focus
resources marshals to `[]` rather than `null`, and the frontend can map over
it without a guard.

*Cost:* this adds a `GetResourceState` lookup per focus resource per worktree
to `/api/worktrees`. The endpoint already does one `resources.Load` per
worktree, and `docs/web-ui-architecture.md` already records this class of N+1
as accepted at current volume. If the list grows slow, batch
`GetResourceState` — do not drop the feature.

**1b. Resource-filtered worktree timeline**

`handleWorktreeTimeline` accepts two new optional query params,
`resource_type` and `resource_id`. Both absent → current behavior, unchanged.
Both present → only that resource's events. One present without the other is a
`400`.

Filtering must **not** enrich-then-discard: `enrichEvent` runs three DB
queries per event. Instead, resolve the resource's event ids once:

```sql
SELECT event_id FROM watcher_event_resources
WHERE resource_type = ? AND resource_id = ?
```

Load those into a `map[string]struct{}`, then walk the descending event list
skipping non-members, enriching only kept events until `limit` is reached.
This keeps the filter **before** the limit, so a filtered page is genuinely
the newest N events for that resource.

`webui` already issues raw SQL against `watcher_event_resources` (see
`enrichEvent`), so a local query here is consistent with existing practice.

### 2. Selection state

New hook `useSelectedResource()`:

```ts
type ResourceKey = { type: string; id: string }

function useSelectedResource(): {
  selected: ResourceKey | null
  select: (key: ResourceKey) => void
  clear: () => void
  toggle: (key: ResourceKey) => void   // select, or clear if already selected
}
```

- Serialized as `?resource=<type>:<encodeURIComponent(id)>`.
- **Parsing splits on the first colon only.** Slack resource ids are
  themselves `channel:threadTs` (e.g. `C123:1700000000.000100`), so the
  remainder after the first colon is the id verbatim. The id is
  percent-encoded on write and decoded on read regardless.
- `select`/`toggle`/`clear` push a history entry so the browser back button
  deselects.
- The hook is the single source of truth for both the wide-viewport card
  highlight and the narrow-viewport drilldown.

**Stale selection.** A `?resource=` value that matches no current resource
(removed out-of-band, or a stale shared link) must not render an empty pane.
The detail page resolves `selected` against the loaded resource list; if there
is no match once resources have loaded, it clears the param and shows the
unfiltered view. Selection is likewise cleared when the selected resource
disappears from a refetch.

### 3. Components

**`WorktreeCard`** (new; used by HomePage *and* WorktreeDetailPage)

```ts
interface WorktreeCardProps {
  w: WorktreeSummary
  /** When true the whole card navigates to the worktree detail page.
   *  False on the detail page itself, where we are already there. */
  clickable?: boolean
}
```

Renders: branch (prominent), repo, a `missing` badge when `!on_disk`, the
existing resource-count summary, then **one line per focus resource** —
`ResourceStatusIcon` + title (falling back to id) + an external link to the
resource URL.

Click behavior: the card body navigates to `/worktree/<encoded path>`;
resource links call `stopPropagation()` so they open the resource instead of
navigating. The card is a real interactive element (keyboard focusable, Enter
activates) rather than a click handler on a `div`.

**`ResourceStatusIcon`** (new)

One mapping from `(type, state/status)` to a tabler icon plus colour, so the
compact list, the card, and the detail pane can never disagree:

| Resource | Condition | Icon | Colour |
|---|---|---|---|
| PR | `state` open | `IconGitPullRequest` | green |
| PR | `state` merged | `IconGitMerge` | violet |
| PR | `state` closed | `IconGitPullRequestClosed` | red |
| Jira | `status` matches `/done|closed|resolved/i` | `IconTicket` | green |
| Jira | `status` matches `/progress|review/i` | `IconTicket` | blue |
| Jira | any other `status` | `IconTicket` | gray |
| Slack | — | `IconMessage` | grape |
| any | not yet enriched | `IconCircleDashed` | gray |

**`ResourceCard`** (existing; extended)

Gains `variant?: "compact" | "detail"`, `selected?: boolean`, and
`onSelect?: () => void`.

- `compact` (default) is today's card, **minus Jira labels** — labels move to
  the detail variant, per the requirement to thin out the list.
- `detail` adds the fuller summary: Jira labels, and the remaining
  type-specific fields.
- When `onSelect` is provided the card is selectable: interactive, with a
  highlighted appearance when `selected`. The remove control calls
  `stopPropagation()` so removing never toggles selection.

**`ResourceDetailPane`** (new — the swappable slot)

```ts
interface ResourceDetailPaneProps {
  path: string
  resource: ResourceDTO
  onBack?: () => void   // rendered as the narrow-viewport back control
}
```

Phase A renders `ResourceCard variant="detail"` above a timeline filtered to
that resource. Phase B adds a branch: when `resource.type === "slack"` it
renders the thread instead. **This branch is the whole of item 6's layout
work** — the surrounding responsive shell, selection state, and back control
are unchanged.

### 4. Responsive behavior

`useMediaQuery('(min-width: 48em)')` from `@mantine/hooks` — 48em is Mantine's
`sm`, matching the existing `Grid.Col span={{ base: 12, sm: N }}` breakpoints
so the layout never switches inconsistently with itself.

**HomePage**
- Wide: today's two-column `Grid` (worktree cards | timeline).
- Narrow: a `Tabs` bar with **Worktrees** and **Timeline** panels, defaulting
  to **Worktrees**. The tab bar renders *only* when narrow — it must not
  appear in the wide layout.

**WorktreeDetailPage**
- `WorktreeCard clickable={false}` at the top, above the tabs.
- Overview content becomes master-detail:
  - Wide: resource list beside `ResourceDetailPane` (or the unfiltered
    timeline when nothing is selected).
  - Narrow, nothing selected: the resource list.
  - Narrow, something selected: `ResourceDetailPane` with an
    "← all resources for worktree" control that calls `clear()`.

Because both presentations read the same `?resource=` value, resizing the
viewport swaps presentation with the selection intact, and the back control
and a second click on a selected card are the same `clear()`/`toggle()` call.

### 5. Data flow

```
/api/worktrees ──> WorktreeSummary[] (now incl. focus_resources)
                     └─> WorktreeCard (HomePage list, DetailPage header)

?resource= ──> useSelectedResource ──┬─> ResourceCard.selected (wide)
                                     └─> drilldown vs list (narrow)
                        │
                        └─> useWorktreeTimeline(path, selected)
                              └─> /api/worktree-timeline?...&resource_type&resource_id
```

`useWorktreeTimeline` takes an optional resource key and includes it in the
React Query key, so selecting a resource is a normal cache-keyed fetch and
switching back to unfiltered is a cache hit.

## Error and degenerate states

- **Never-polled resource** — no enrichment fields; card shows the existing
  minimal presentation and `ResourceStatusIcon` renders the gray dashed icon.
  Slack cards keep rendering (they already do) rather than degrading.
- **Stale `?resource=`** — cleared once resources have loaded with no match
  (see *Stale selection*).
- **Selected resource removed** — selection clears on the refetch that drops
  it; the pane returns to the unfiltered view.
- **Worktree missing on disk** — `missing` badge, card still renders.
- **Timeline filter with no events** — the existing "No events yet." empty
  state, not an error.
- **One of `resource_type`/`resource_id`** — `400`, so a malformed client
  request fails loudly instead of silently returning an unfiltered page.

## Testing

**Go (`internal/webui`)**
- `focus_resources` contains only primaries, is enriched, and is empty (not
  null-panicking) for a worktree with no resources.
- Timeline filter returns only the resource's events; **the filter is applied
  before the limit** (seed more matching events than `limit` interleaved with
  non-matching ones and assert a full page of matches).
- Missing one of the two params → 400.

**Frontend (vitest)**
- `useSelectedResource`: round-trips a key through the URL; splits on the
  first colon only (Slack ids with an embedded colon survive); `toggle`
  clears an already-selected key.
- `WorktreeCard`: renders a line per focus resource; card click navigates;
  resource-link click does not navigate.
- `ResourceStatusIcon`: state → icon/colour mapping.
- `ResourceCard`: `selected` styling; remove control does not toggle
  selection; Jira labels absent in `compact`, present in `detail`.
- HomePage: tabs present when narrow, absent when wide.
- DetailPage: narrow + selected shows the drilldown with a back control;
  clearing returns to the list; the same state drives both layouts.

⚠️ **Test trap:** `ui/src/test-setup.ts` stubs `matchMedia` with
`matches: false`, so `useMediaQuery` reports **narrow** by default and every
existing test renders the narrow layout. Wide-layout tests must opt in. Add an
explicit helper (e.g. `setViewport("wide" | "narrow")`) rather than leaving
each test to re-stub `matchMedia` ad hoc.

## Phase B design (item 6)

Once Phase A is in use:

- Remove the Overview/Slack `Tabs` from `WorktreeDetailPage`; the resource
  list plus `ResourceDetailPane` becomes the whole page body.
- Remove the Slack thread rail (`SlackTab`'s `NavLink` list) and
  `SlackTab` itself; Slack threads are selected like any other resource.
- `ResourceDetailPane` branches on `resource.type === "slack"` and renders
  `ThreadView` (via `useThread`) in place of the filtered timeline.
- No resource summary card above a Slack thread — `ThreadView` already has its
  own title/description header.
- The responsive drilldown from item 5 applies unchanged: narrow viewports
  drill into the thread with the same back control.
- `ThreadRailLabel` and `useTabMetas` lose their only consumer when the rail
  goes. Decide then whether the rail metadata (author, started/active, unread)
  should move onto the Slack `ResourceCard`; do not delete them blindly.

## Out of scope

- Drag-to-reorder resources (tracked in `docs/ui-feature-roadmap.md`; needs a
  persisted order column in worktree's own DB).
- Timeline pagination / "load more" (`next_cursor` still unused).
- Removing the now-unused `@dnd-kit/*` dependencies.
- Any change to the watcher library.
- **Making `enrichEvent` cheaper.** It currently runs three DB queries per
  event (`watcher_event_resources` lookup, `resourceTitle`,
  `worktreesWatching`), so rendering a page of N events costs ~3N queries.
  A follow-up should collapse this into a single join (or a batched
  pre-fetch keyed by event id) rather than per-row lookups. This design works
  *around* the cost — the timeline filter deliberately avoids
  enriching events it will discard — but does not fix it. Tracked in
  `docs/ui-feature-roadmap.md`.

## Risks

- **`/api/worktrees` gets heavier.** Accepted; batch `GetResourceState` if the
  home page becomes slow.
- **Selection/media-query interaction is the subtle part.** The invariant to
  protect in tests: resizing the viewport changes layout only — never the URL,
  never the selection.
- **Phase B deletes working UI.** Deferred deliberately so the new pattern can
  be lived with first.
