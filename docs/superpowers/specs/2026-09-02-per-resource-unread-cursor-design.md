# Per-resource unread cursor — design

**Date:** 2026-09-02
**Status:** approved, ready for an implementation plan

## Goal

Give every tracked non-Slack resource a read cursor, and surface "there is
something here you have not seen" consistently across the web UI and the CLI.

Slack threads are deliberately excluded from the cursor: Slack already owns a
read cursor for the current user, worktree already reads it
(`slack.UnreadDividerIndex`, cached as `has_unread`), and two systems must not
both claim authority over the same thread. Slack participates in the *display*
half of this feature — its unread dot appears wherever a resource is named,
exactly like a PR's — but never in the storage half.

## What this is not

This is **not** agent-handler's unread model. Handler tracks a cursor per
*subscriber*, so each session has its own read state. This is a cursor per
*resource*, shared by every worktree that tracks it.

The consequence is intended and worth stating plainly: if a PR is tracked by
two worktrees, marking it read in one clears its dot in both. You read the PR,
not the worktree.

## Storage

A worktree-owned table, created in `internal/db/migrate.go`:

```sql
CREATE TABLE IF NOT EXISTS resource_read_cursor (
	resource_type TEXT NOT NULL,
	resource_id   TEXT NOT NULL,
	last_read_ts  TEXT NOT NULL,
	updated_at    TEXT NOT NULL,
	PRIMARY KEY (resource_type, resource_id)
)
```

**Worktree-owned, not a watcher library change.** The table has no `watcher_`
prefix, so the library's collision check ignores it, and joining it against
`watcher_*` tables follows the existing `worktree_primary` precedent. The
library's other consumer (agent-handler) has its own per-subscriber model and
must not inherit this one. No library release, no re-pin.

**No new index is required.** The count query's join column is already covered
by `idx_watcher_event_resources_resource (resource_type, resource_id)` in the
library schema.

### The cursor is on `watcher_events.ts`

Not `external_ts`. Both timeline queries `ORDER BY e.ts DESC`, and
`external_ts` is nullable and can run out of order relative to `ts`. A cursor
on `external_ts` would let read and unread events interleave in display order,
which makes the divider a lie — it would claim everything above it is new when
some of it is not.

Unread is `e.ts > last_read_ts`, **strictly** greater, so setting the cursor to
the newest event's ts leaves exactly zero unread.

## Seeding: a new resource starts silent

A resource with no cursor row reads as zero unread. That rule alone would mean
a resource never accrues its first dot, so rows must actually get written:

- **Migration backfill.** One row per currently-subscribed non-Slack resource,
  at `MAX(ts)` of that resource's events, or `now` if it has none. Existing
  history is therefore read, and the feature starts silent. The backfill runs
  on every `migrate()` and is insert-or-ignore, so after the first run it
  inserts nothing — `resources.Add` has already seeded anything newer. It
  doubles as a safety net for a row that somehow went missing, at the cost of
  reading that one resource's backlog as seen.
- **`resources.Add` seeds new subscriptions** at `now`, insert-or-ignore. The
  ignore matters: a second worktree subscribing to a resource someone already
  reads must inherit the existing cursor, not reset it.

After the migration a missing row is unreachable — every add path goes through
`resources.Add` (CLI, web API, and agent-handler's shell-outs). Read-time
therefore treats a missing row as zero unread rather than erroring: the failure
mode is a quiet resource, never a false backlog.

Both seeding paths skip `type == "slack"`.

## Counting

One query, scoped by subscriber for a worktree or unscoped for the global
timeline:

```sql
SELECT er.resource_type, er.resource_id, COUNT(*)
  FROM watcher_event_resources er
  JOIN watcher_events e ON e.id = er.event_id
  JOIN resource_read_cursor c
    ON c.resource_type = er.resource_type AND c.resource_id = er.resource_id
 WHERE e.ts > c.last_read_ts
 GROUP BY er.resource_type, er.resource_id
```

The **inner** join on the cursor table does three jobs at once: it excludes
Slack threads (never seeded), unseeded resources (treated as read), and fully
read resources (count zero, no row in the result).

## API

### Fields

- `resourceDTO` gains `unread_count int` (`json:"unread_count"`). Always 0 for
  Slack, which keeps `has_unread`.
- `TimelineEvent` gains `unread bool` (`json:"unread"`). This drives per-event
  dots in the unified timelines.

The frontend never branches on resource type at a call site. One helper —
`ui/src/lib/unread.ts` — answers `hasUnread(r)` as
`r.type === "slack" ? !!r.has_unread : (r.unread_count ?? 0) > 0`, and every
surface calls it.

### Slack events carry no per-event unread flag

`unread` is always `false` on a Slack-sourced timeline event. Slack's read
state is a message ts held in the thread, and the cached resource state stores
only the derived `has_unread` boolean — there is no per-message cursor here to
compare an event against. Inventing one would be a second Slack read model.

A Slack thread's unread state still reaches the timeline: it shows on the
event's resource chip, via `hasUnread`.

If per-event Slack dots are ever wanted, the honest route is to cache the
thread's `last_read` in `state_json` — a watcher library change, not a local
workaround.

### Endpoint

`POST /api/resource-read`, body `{type, id, through_ts}`, returns 204.

`through_ts` is **the newest event ts the client actually rendered**, never
"now" and never a server-side `MAX(ts)`. If events land between render and
click, they stay unread instead of being swallowed by a button that promised to
clear a specific number. A request naming a `through_ts` older than the stored
cursor is a no-op — the cursor only moves forward.

A request for a Slack resource is rejected with 400.

## Web UI

### Unread dot wherever a resource is named

`ResourceStatusIcon.tsx` today renders `UnreadDot` inside `ResourceTitle` only,
and only for Slack. It becomes an exported `<UnreadDot r={r} />` that decides
for itself via `hasUnread`, rendered at all three resource surfaces:

- `ResourceTitle` (resource cards) — already has one; it changes to the shared
  rule so PRs and Jira issues get it too.
- `WorktreeCard`'s focus resource lines — uses the bare icon today and misses
  the dot entirely.
- `EventResourceChip` — same.

### Unified timelines: a dot per unread event

In the global timeline and in a worktree's timeline with no resource selected,
events from multiple resources interleave, so unread events are not strictly
newer than read ones and a single divider cannot be drawn. Each unread event
gets its own dot instead.

Placed in `EventRow`, immediately left of the event title — deliberately not on
the rail dot, which already encodes event type and would otherwise carry two
unrelated signals in one mark.

### Single-resource timeline: a divider and a mark-read button

In `ResourceDetailPane`'s `TimelineBody` the feed is one resource ordered by
`ts DESC`, so every unread event is contiguous at the top and a divider is
meaningful. It goes above the oldest event with `unread: true` — no extra
response field is needed to place it.

The Slack thread view's existing divider (`Divider label="New"` in
`ThreadView.tsx`) is extracted into a shared component so both dividers are
visibly the same thing.

The Activity header gains a **"Mark N events as read"** button, shown only when
`N > 0`. `N` is the resource's `unread_count`, and the request's `through_ts`
is the newest rendered event's `ts`. Those agree by construction: the feed is
descending, so clearing through the newest rendered event clears every older
unread one.

Nothing marks a resource read implicitly. Viewing a filtered timeline does not
move the cursor, matching the rule Slack threads already follow.

### Invalidation

The mark-read mutation's `onSuccess` invalidates `["worktrees"]` (card dots),
`["worktree-resources", path]` (resource cards and counts), and the timeline
queries (dots and divider). The existing SSE `events_new` signal continues to
handle newly arriving events.

## CLI

- `worktree resources list` appends ` (N unread)` to a row whose resource has
  a non-zero count, and prints nothing extra otherwise — the existing
  `<marker> <type>:<id> <url>` shape is unchanged for a fully read resource.
  `--json` output gains `unread_count`, emitted with `omitempty` so a read
  resource's object is byte-identical to today's.
- `worktree resources mark-read <type> <id> [--through <ts>]` moves the cursor,
  defaulting to the resource's newest event ts. Rejects a Slack resource with a
  message pointing at the web UI's thread view, which owns that read state.

## Testing

- **Storage:** seeding is insert-or-ignore (a second subscriber does not reset
  a cursor); the migration backfill lands existing resources at their newest
  event; Slack is skipped by both paths.
- **Counting:** strict `>` leaves zero unread at the newest event; a resource
  with no cursor row counts zero; a Slack resource counts zero even with events.
- **Endpoint:** a `through_ts` older than the stored cursor is a no-op; a
  Slack resource is a 400; events newer than `through_ts` survive the mark.
- **UI:** `hasUnread` picks the right field per type; the divider lands above
  the oldest unread event; the button's count matches `unread_count` and
  disappears at zero; the dot appears on all three resource surfaces.
