# Web UI architecture

`worktree ui` starts a local web UI: a Go HTTP server with an embedded React
frontend. This doc maps the current code (Phase 2) so future sessions can
extend it without re-deriving the structure from scratch. If you're about to
touch the UI, read the relevant section below before spelunking the source.

## Overview

- Command: `cmd/ui.go` (`worktree ui`). Flags:
  - `--port` (default `8475`) — HTTP port.
  - `--no-open` — don't auto-open the browser.
  - `--api-only` — serve only the API, no embedded static assets (used by the
    Vite dev server, which proxies `/api` to this).
- Ports: **8475** production (Go server, serves API + embedded frontend),
  **5175** Vite dev server (`make dev`), which proxies `/api/*` to 8475.
- `runUI` (`cmd/ui.go`) opens the worktree DB (`wdb.Open()`), builds a
  `webui.Server`, starts the in-process poll loop (`srv.StartPolling(2 *
  time.Minute)`), opens the browser (unless `--no-open`/`--api-only`), then
  calls `srv.Start()` which blocks on `http.ListenAndServe`.

### Detecting an already-running UI

`serverAlreadyListening(port)` (`cmd/ui.go`) is a 200ms TCP dial to
`127.0.0.1:<port>`. `runUI` uses it to avoid an "address already in use"
failure — if something answers, it just opens that URL and exits 0.

The cmux workspace-creation flow reuses the same check via
`runningUIDetailURL(conn, wtPath)`, which on a hit composes
`http://127.0.0.1:8475` + `detailPathForToplevel(wtPath, registry.List(conn))`
— the same registry matcher `runUI` uses for its own auto-open, so
`wdb.Subscriber` canonicalization (symlinked paths) behaves identically in both
places. The resulting URL becomes the first, pinned browser tab of the new
workspace (see `buildWorkspaceURLs` in `cmd/root.go` and `cmux.PinBrowserTabs`).

**The probe is hardcoded to `defaultUIPort` (8475).** `worktree ui` records its
actual port nowhere — no pidfile, no state file — so `serverAlreadyListening`
only ever answers "is anything on the port I was about to use". A UI started
with `--port 9000` is therefore invisible to the workspace-creation flow, which
falls back to its no-UI behavior. Making custom ports work means giving the UI
somewhere to record its port; don't mistake the current check for real
discovery.

## Delivery / embed model

- Root package `web_embed.go`: `//go:embed all:ui/dist` into `EmbeddedWeb
  embed.FS`. `main.go` passes it to the `cmd` package via
  `cmd.SetWebFS(EmbeddedWeb)`, which stores it in `cmd.globalWebFS`
  (`cmd/root.go`).
- `runUI` takes `fs.Sub(globalWebFS, "ui/dist")` and passes that sub-FS as
  `webui.Server.WebFS` (rooted at the dist dir, i.e. `index.html` is at the
  top level of the FS). If `--api-only`, `WebFS` is left `nil` and
  `DevMode: true` so no static handler is registered at all.
- `ui/dist/.gitkeep` is a committed placeholder; `ui/dist/*` (built assets) is
  gitignored (see `.gitignore`: `ui/dist/*` + `!ui/dist/.gitkeep`). This means
  a fresh checkout has no built UI — `hasBuiltUI()` in `cmd/ui.go` checks for
  any file other than `.gitkeep` and errors with "web UI not built. Run 'make
  build-web' first" if missing.
- `make build` runs `build-web` (npm install + `npm run build` in `ui/`) then
  `build-cli` (`go build`), in that order, so the `//go:embed` picks up fresh
  assets. Building the Go binary alone (skipping `build-web`) embeds
  whatever is already in `ui/dist` (possibly nothing but `.gitkeep`).

## Backend structure (`internal/webui/`)

- **`server.go`** — `Server struct { DB *sql.DB; WebFS fs.FS; Port int;
  DevMode bool; Logger *log.Logger; pollInFlight atomic.Bool }`.
  - `Handler() http.Handler` builds a `http.ServeMux`, calls
    `registerAPI(mux)`, and (if `!DevMode && WebFS != nil`) mounts
    `serveStatic` at `/`.
  - `registerAPI(mux)` is the single place all routes are registered — the
    extension point for new endpoints (see table below).
  - `serveStatic` implements SPA fallback: for a non-`/` path, if
    `fs.Stat(WebFS, path)` finds a **real file** (`!info.IsDir()`), it's
    served via `http.FileServer(http.FS(WebFS))`. Otherwise (real directory,
    e.g. `/assets/`, or a missing path, e.g. a client-side route like
    `/worktree/foo`) it falls through and serves `index.html`. The
    `!info.IsDir()` check matters — without it, a directory request would hit
    Go's default directory-listing behavior instead of the SPA shell (this
    was a real bug fixed in Task 9 of the Phase 2 build).
  - `writeJSON(w, status, v)` / `writeError(w, status, msg)` are the shared
    response helpers used by every handler.
- **`worktrees.go`** — `GET /api/worktrees`.
- **`timeline.go`** — `GET /api/timeline` (global) and `GET
  /api/worktree-timeline` (scoped). Also owns `eventEnricher` (see below) and
  `latestEventTSForSubscriber` (used by both `worktrees.go` and `poller.go`).

  **`eventEnricher` is request-scoped by design.** Both timeline handlers
  build one (`newEventEnricher`) and drop it with the response. It holds the
  canonical-subscriber → branch map built once from the registry, plus memos
  of resource titles and worktree attribution. Do **not** promote it to a
  field on `Server`: its contents change when the poller writes
  `watcher_resource_state` and when subscriptions change — including from
  *other processes* (`worktree add`, `worktree resources set-name`, and
  agent-handler shelling out to the CLI all write this same SQLite file), which
  this server cannot observe. At request scope there is nothing to invalidate.
- **`resources_api.go`** — `GET /api/worktree-resources`, enriched from the
  cached `watcher_resource_state` row via `watcherdb.GetResourceState`.
- **`resource_mutate_api.go`** — `POST /api/worktree-resources/add` and `POST
  /api/worktree-resources/remove` (see below). Owns `inferResource`
  (`inferresource.go`), which parses a pasted GitHub PR or Jira issue URL into
  `(type, id)`.
- **`poller.go`** — `StartPolling(interval) (stop func())` (interval loop),
  `pollAll` (polls all active `pr`/`jira` resources), `isWorktreeStale`,
  `POST /api/worktrees/poll` (poll-on-view), and the `pollInFlight`
  atomic-bool guard (`safePollAll`) against overlapping polls.
- **`stream.go`** — `GET /api/stream`, an SSE endpoint.
- **`slack.go`**, **`slack_proxy.go`**, **`slack_sse.go`** — the Slack thread
  view's routes (`/api/thread*`, `/api/slack-*`); see "Slack thread view" below.

## HTTP API surface

All responses are JSON (`application/json`) except `/api/stream` (SSE). Field
names below are the literal Go struct tags — this is the frontend↔backend
contract; `ui/src/api/types.ts` must match it field-for-field.

| Method | Path | Params | Response |
|---|---|---|---|
| GET | `/api/worktrees` | — | `[]worktreeSummary` |
| GET | `/api/timeline` | `archived` (`"true"`/else false), `limit` (1-500, default 100), `before` (RFC3339 ts, exclusive upper bound) | `timelineResponse` |
| GET | `/api/worktree-timeline` | `path` (required, worktree path), `limit`, `resource_type` + `resource_id` (optional, filters to one resource's events; must be supplied together or the request 400s) | `timelineResponse` |
| GET | `/api/worktree-resources` | `path` (required) | `[]resourceDTO` |
| POST | `/api/worktrees/poll` | `path` (required) | `{"polled": bool}` |
| POST | `/api/resource-meta` | body: `{type, id, name, description}` | — |
| POST | `/api/worktree-resources/add` | body: `{path, url, related?}` | `resourceDTO` |
| POST | `/api/worktree-resources/remove` | body: `{path, type, id}` | 204 No Content |
| GET | `/api/stream` | — | SSE stream (`text/event-stream`) |

### `worktreeSummary` (worktrees.go)

```
path            string
repo            string
branch          string
on_disk         bool             // os.Stat(path) succeeded
resource_count  int              // len(all resources, primary+related)
primary_count   int              // count where !res.Related
primary_by_type map[string]int   // e.g. {"pr": 2, "jira": 3} — primary only
related_count   int
latest_event_ts string           // "" if no events; from latestEventTSForSubscriber
focus_resources []resourceDTO   // primary resources, enriched; always [] never null
```

`focus_resources` lets the home page (and the shared `WorktreeCard`, see
"Frontend structure" below) show each worktree's focus resources — status
icon, title, link — without a second round-trip per worktree. It's built the
same way `handleWorktreeResources` builds a single worktree's resource list
(same enrichment from cached `watcher_resource_state`), filtered to
`!res.Related`, and attached inline on `worktreeSummary`. It is explicitly
initialized to an empty slice rather than left nil, so it always serializes
as `[]` — the frontend can iterate it directly with no null-guard.

### `TimelineEvent` / `timelineResponse` (timeline.go)

```
timelineResponse { events []TimelineEvent, next_cursor string }

TimelineEvent {
  id             string
  ts             string    // watcher-observed timestamp
  external_ts    string    // source (GitHub/Jira) timestamp, may be ""
  source         string
  type           string    // raw watcher.EventType
  type_label     string    // watcher.EventType(type).DisplayName()
  title          string
  body           string
  author         string
  resource_type  string    // "pr" | "jira" | ...
  resource_id    string
  resource_url   string
  resource_title string    // looked up from cached resource_state, "" if unknown
  worktrees      []string  // branch names currently watching this resource
}
```

`next_cursor` is the `ts` of the last event in the page (empty if the page is
empty) — a "before" cursor for pagination. **The frontend does not currently
use it**; `HomePage`/`WorktreeDetailPage` only render the first page (see
"Known deferred items" below).

Global timeline query notes (`handleGlobalTimeline`):
- Excludes internal event types `watch_started` and `watcher_error`.
- Unarchived (`archived=false`, default): joins through
  `watcher_subscriptions` (`s.deleted_at IS NULL`) so only events for
  currently-watched resources show.
- Archived (`archived=true`): skips that join, showing events for resources
  no longer watched by any worktree too.
- Dedup: an event can join to more than one row in `watcher_event_resources`.
  `writeTimelineRows` dedupes by `e.id` in Go (first row wins, deterministic
  given `ORDER BY e.ts DESC`) so each event appears once. **This is currently
  safe** because watcher writes exactly one resource per event today; see
  "Known deferred items."

### `resourceDTO` (resources_api.go)

```
type    string    // "pr" | "jira"
id      string
url     string
primary bool      // !res.Related — see "Focus vs primary" below

// enriched from cached watcher_resource_state (omitempty; absent if never polled):
title                     string    // PR title or Jira summary
state                     string    // PR: open/closed/merged
review_decision           string    // PR
ci_status                 string    // PR
new_commits_since_review  bool      // PR
author                    string    // PR author
status                    string    // Jira status
priority                  string    // Jira
issue_type                string    // Jira
assignee                  string    // Jira
labels                    []string  // Jira
updated_at                string    // resource_updated_at, RFC3339

// user-set per-resource overrides (omitempty; absent if never set):
custom_name               string
custom_description        string
```

`custom_name`/`custom_description` come from the watcher library's
`watcher_resource_meta` table (keyed `(resource_type, resource_id)`, added in
**v0.2.8**), not from `watcher_resource_state` — they're user-authored
overrides, not polled/cached upstream data. `POST /api/resource-meta` (body
`{type, id, name, description}`) upserts a row via
`watcherdb.SetResourceMeta`; `Load`-time resource decoration
(`internal/resources`) reads it back, and `handleWorktreeResources` populates
these two fields on the DTO whenever a row exists for that resource.

`enrichResourceDTO` reads `watcherdb.GetResourceState(db, type, id)`, parses
`StateJSON` defensively (comma-ok type assertions on every field), and
degrades to an unenriched DTO (all enrichment fields empty) if the resource
was never polled (`GetResourceState` returns `nil, nil` — expected, not
logged) or the cached JSON is malformed (also not logged). A genuine DB error
from `GetResourceState` **is** logged via `s.Logger`.

### Add/remove resource (`resource_mutate_api.go`)

`POST /api/worktree-resources/add` — body `{path, url, related?}`. Infers
`(type, id)` from `url` via `inferResource` (shared with the CLI's URL
matching; the PR id format is load-bearing — a UI-added PR must produce the
same id shape as `cmd/root.go`'s `worktree add <pr-url>` so cached
`watcher_resource_state` rows line up). On success: creates the subscription
via `resources.Add`, then best-effort inline-enriches it by calling
`s.pollOne` synchronously (same per-type dispatch as the background poller)
so the response DTO already has title/state/etc. instead of waiting for the
next 2-minute poll tick, then returns the built `resourceDTO`. 400s on
missing `path`/`url` or an unrecognized URL (`inferResource` returns
`ok=false`); 500 if `resources.Add` fails.

`POST /api/worktree-resources/remove` — body `{path, type, id}`. Hard-deletes
the resource via `resources.Remove` (removes the `watcher_subscriptions` row
and clears the `worktree_primary` flag if set) and returns `204 No Content`.
400s on any missing field; 500 on a `resources.Remove` error. There is no
soft "Unwatch" (keep history, stop polling) in this UI yet — Phase-5 soft-stop
semantics are still unsettled, so remove is intentionally the only control
exposed.

Frontend: `api.addResource`/`api.removeResource` (`ui/src/api/client.ts`).
Three UI entry points all call these and then refetch via
`useWorktreeDetail`'s `resources.refetch()` (passed down as `onChanged` /
`onRemoved`) rather than optimistically patching local state:
- The Overview tab's "Add resource" button (`ResourceList.tsx`), which opens
  the shared **`AddResourceModal`** (see below).
- The remove control (`RemoveControl` in `ResourceCard.tsx`) — a `×` behind a
  `Popover` confirm step, with its own inline error feedback if
  `removeResource` fails.

  **Placement (Phase C):** the remove control appears only on the *detail*
  side, never on the selectable cards in the resource list — with list cards
  clickable-to-select, a per-card `×` was noise and an easy mis-click. So it
  renders when `ResourceCard` has `variant="detail"`, and for a Slack thread
  (which has no detail `ResourceCard`) `SlackThreadPane` injects the same
  `RemoveControl` into `ThreadView`'s header card via its `headerAction` slot.
  Without that slot a Slack thread would be the one resource type you could
  not remove from the UI.
Slack threads are added through that same "Add resource" button —
`inferResource` recognizes Slack thread URLs. (Phase B removed the Slack
tab's separate `+` button along with the tab; since the resource list is now
the whole page body rather than one tab of two, the button is always visible.)

**`AddResourceModal` (`ui/src/components/AddResourceModal.tsx`)** — the single
add-resource dialog used by the worktree detail page's resource list. It prompts
for:
- a URL (PR, Jira, or Slack),
- **Focus vs Related** via a `SegmentedControl` (default Focus; `defaultRelated`
  prop flips the default) with a dimmed helper line — this maps to the
  `related` flag on `POST /api/worktree-resources/add` (Focus → `related:
  false`, Related → `related: true`), i.e. the backend `primary`/`Related`
  distinction. **This is why the "Focus/Related" choice exists in the UI at
  add time** (previously the inline box could only add as Focus).
- optional **Name/Description**, revealed only when the URL contains
  `slack.com`. On submit, after `addResource` succeeds, these are persisted via
  `api.setResourceMeta({type, id, ...})` using the returned DTO's `type`/`id`
  (no client-side URL parsing). Shows an inline error `Alert` and stays open if
  `addResource` rejects (e.g. unrecognized URL).

### SSE (`/api/stream`)

No params. On connect, sends nothing but flushes headers. Every 5s, checks
`MAX(ts)` on `watcher_events`; if it advanced since the last tick (or since
connect), emits `event: events_new\ndata: {}\n\n`, then always emits `event:
heartbeat\ndata: {}\n\n`. The frontend treats `events_new` purely as a
cache-invalidation signal (no payload).

## CRITICAL GOTCHA: subscriber canonicalization

**`watcher_subscriptions` rows are keyed by `wdb.Subscriber(path)`
(`internal/db`), NOT by `"worktree:" + path`.** `wdb.Subscriber` does
`filepath.Abs` → `filepath.EvalSymlinks` → `filepath.Clean` on the path. On
macOS (`/tmp` → `/private/tmp`, symlinked home directories, etc.) or with
symlinked worktree paths, a naive `"worktree:" + rawPath` string will **not**
match the stored subscriber — the query silently returns zero rows instead of
erroring.

**Every place that builds a subscriber string, or joins the `worktrees`
table (raw paths) against `watcher_subscriptions` (canonical subscribers),
must go through `wdb.Subscriber(path)`.** This bit the Phase 2 build
repeatedly (it was flagged and fixed across Tasks 2, 3, and 4 — see
`latestEventTSForSubscriber`, `handleWorktreeTimeline`, `worktreesWatching`,
and `isWorktreeStale`, all of which canonicalize via `wdb.Subscriber`). If you
add a new endpoint or query that needs to map a worktree path to its
subscriptions, follow the same pattern — build a `map[canonicalSubscriber]branch`
from `registry.List` (canonicalizing each path with `wdb.Subscriber`) rather
than doing the join in raw SQL against `worktrees.path`.

## Polling model (in-process only)

There is no external scheduler for the UI's poller (unlike agent-handler's
launchd/cron-scheduled one-shot watcher commands). `worktree ui` runs a
single in-process loop for as long as the server is up:

- **Interval loop**: `StartPolling(2 * time.Minute)` (called from
  `runUI`) does an immediate poll, then one every 2 minutes, until `stop()`
  is called (deferred in `runUI`, so it stops when the process exits).
- **Poll-on-view-if-stale**: `POST /api/worktrees/poll?path=` (called by the
  frontend when a worktree detail page mounts — see `useWorktreeDetail`)
  polls only if `isWorktreeStale(path, time.Minute)` — i.e. the worktree's
  newest event is more than 1 minute old (or it has none).
- Both call `safePollAll()`, guarded by `pollInFlight` (an `atomic.Bool`): if
  a poll is already running, the second caller no-ops immediately rather than
  queuing or blocking.
- **Accepted tradeoff**: the DB goes stale whenever the server isn't running
  (no server = no polling). This is intentional — there's no background
  daemon.
- `pollAll` polls all active `pr`, `jira`, and (as of Phase 4) `slack`
  resources (via `watcherdb.ActiveResources`), skipping (with a log line, not
  an error) any source whose credentials aren't configured. Slack threads are
  polled via `github.com/mturley/watcher/slack`'s `Poll(db, auth, threads,
  logger)` — the same library entry-point shape as `wgithub.Poll`/`wjira.Poll`
  — which writes `slack_reply` timeline events (`watcher_events`) for new
  replies and refreshes `watcher_resource_state` for each thread. This is
  separate from worktree's own live-tab `internal/slackpoller`, an in-memory
  SSE poller that only runs while a Slack thread is open in the UI; `pollAll`
  keeps Slack threads current even when no tab is open, same as PRs/Jira.

## Frontend structure (`ui/src/`)

- **`api/client.ts` + `api/types.ts`** — the typed API contract. `types.ts`
  interfaces (`WorktreeSummary`, `TimelineEvent`, `TimelineResponse`,
  `ResourceDTO`) **must match the Go DTOs field-for-field** (same JSON key
  names) — this is the single source of truth for what the frontend expects
  back from each endpoint listed above. `client.ts` exports `api.worktrees`,
  `api.globalTimeline`, `api.worktreeTimeline`, `api.worktreeResources`,
  `api.pollWorktree`, `api.setResourceMeta`, `api.addResource`,
  `api.removeResource`.
- **Hooks** (`ui/src/hooks/`):
  - `useWorktrees()` — `useQuery(["worktrees"], api.worktrees)`.
  - `useGlobalTimeline(archived)` / `useWorktreeTimeline(path, resource?)`
    (`useTimeline.ts`) — query keys `["timeline","global",archived]` /
    `["timeline","worktree",path,key]`, where `key` is `""` for the
    unfiltered timeline or `"<type>:<id>"` when a `resource` (`{type, id}`)
    is passed. Including the resource in the query key means switching the
    selection is a normal cache-keyed fetch, and switching back to
    unfiltered is a cache hit rather than a refetch. `resource` is passed
    straight through to `api.worktreeTimeline` as the
    `resource_type`/`resource_id` query params (see the HTTP API table).
  - `useWorktreeDetail(path)` — fires `api.pollWorktree(path)` on mount
    (poll-on-view), and if the response says `polled: true`, invalidates
    `["timeline","worktree",path]` and `["resources",path]`; also runs
    `useQuery(["resources",path], api.worktreeResources)` and reuses
    `useWorktreeTimeline(path)` (unfiltered — resource filtering happens
    separately, in `ResourceDetailPane`).
  - `useSSE()` — connects to `/api/stream`; on `events_new`, invalidates the
    `["timeline"]` and `["worktrees"]` query key prefixes so React Query
    refetches. Auto-reconnects (3s backoff) on error. This is a pure
    invalidation signal — it carries no event payload itself.
  - `useIsWide()` (`useIsWide.ts`) — **the single responsive breakpoint
    predicate for the whole app.** Wraps Mantine's `useMediaQuery` at
    `(min-width: 48em)` (Mantine's `sm`, matching the existing `Grid` `sm`
    breakpoints) with `getInitialValueInEffect: false` so the first render
    already reads `matchMedia` instead of guessing narrow-then-flipping.
    Every layout that needs to branch on viewport width (currently
    `HomePage` and `WorktreeDetailPage`) calls this rather than its own
    `useMediaQuery`, so all of them flip at the same width, and tests have
    exactly one thing to control (`testing/viewport.ts`'s `setViewport`,
    see "Testing note" below) instead of one `matchMedia` mock per
    component.
  - `useSelectedResource()` (`useSelectedResource.ts`) — the selected
    resource, stored in the URL as `?resource=<type>:<id>` rather than
    component state. Returns `{ selected, select, clear, toggle }`, where
    `selected: ResourceKey | null` (`ResourceKey = { type, id }`,
    `lib/resourceKey.ts`). Keeping selection in the URL makes it
    deep-linkable, survives a refresh, and is undoable via the browser back
    button; it is also the single source of truth shared by the
    wide-viewport highlighted card and the narrow-viewport drilldown (see
    below), so resizing the window swaps *presentation* without disturbing
    *what* is selected. `serializeResourceKey`/`parseResourceKey`
    (`lib/resourceKey.ts`) do the encode/decode: the id is
    percent-encoded, and parsing splits on the **first** colon only,
    because a Slack resource id is itself `channel:threadTs` — everything
    after the first colon belongs to the id. A malformed or stale
    `?resource=` value degrades to "nothing selected" rather than
    throwing.
- **Pages** (`ui/src/pages/`):
  - `HomePage.tsx` — worktree list + global timeline + archived toggle. On
    wide viewports these render side by side in a `Grid`; on narrow
    viewports (per `useIsWide()`) they render as a `Tabs` ("Worktrees" /
    "Timeline") instead, since the two panes stacked vertically would push
    the worktree list far off-screen.
  - `WorktreeDetailPage.tsx` — resolves the path from the wouter route,
    renders the shared `WorktreeCard` (see below) as a page header, an
    "Overview"/"Slack" `Tabs`, and inside "Overview": `ResourceList`
    (Focus/Related sections, selection-aware) plus either the scoped
    `TimelineFeed` or a `ResourceDetailPane` for the selected resource — see
    "Responsive resource selection" below for exactly how those combine.
- **Components** (`ui/src/components/`): `WorktreeList`, `TimelineFeed`,
  `EventRow`, `ArchivedToggle`, `ResourceList` (splits into Focus/Related by
  `r.primary`, selection-aware), `ResourceCard` (see "Rich resource cards"
  below), `WorktreeCard` and `ResourceDetailPane` (see "Responsive resource
  selection" below).
- **Lib** (`ui/src/lib/`): `resourceSummary.ts` (builds the "2 PRs, 3 Jira
  issues · 2 related resources" summary string from `primary_by_type` +
  `related_count`), `relativeTime.ts`, `resourceKey.ts` (see
  `useSelectedResource` above).
- **Routing**: `wouter`. `App.tsx` defines `/` → `HomePage`, `/worktree/:path*`
  → `WorktreeDetailPage`. The `:path*` wildcard param comes back from
  `useRoute` under the **typed key `"path*"`** (not `"path"` — a real wouter
  3.10 quirk discovered during the build), i.e. `params?.["path*"]`. Worktree
  paths contain slashes, so the link is built with a single
  `encodeURIComponent(path)` (see `WorktreeList.tsx`) and decoded with a
  single `decodeURIComponent(rawPath)` on the detail page — do not
  double-encode/decode. `useSelectedResource` (above) manages the separate
  `?resource=` query param on top of this route via `wouter`'s
  `useLocation`/`useSearch`.

### Responsive resource selection

Resource *selection* is a `WorktreeDetailPage` concern only — it happens by
clicking a `ResourceCard` in `ResourceList`. A `FocusResourceLine` in a
`WorktreeCard` (home page or detail-page header) is an external link straight
to the resource (GitHub/Jira/Slack), not a selection affordance — there is no
way to select a resource from the home page. Selecting a resource and viewing
it at different widths are two independent concerns, deliberately kept that
way:

- **`WorktreeCard`** (`components/WorktreeCard.tsx`) is the resource-summary
  card for one worktree — branch name, resource-count summary, and (via the
  `focus_resources` field on `worktreeSummary`, see above) a line per focus
  resource with its status icon and title/link. It is **shared** by
  `HomePage` (rendered inside `WorktreeList`, `clickable` — the whole card
  navigates to the worktree detail page, `FocusResourceLine` links stop
  propagation so they open the resource instead) and by
  `WorktreeDetailPage`'s own header (rendered with `clickable={false}`,
  since you're already on that page). One component, one rendering of a
  worktree's identity, used in both places rather than two ad hoc renders
  drifting apart.
- **`useSelectedResource()`** (above) owns *what* is selected, independent
  of viewport.
- **`useIsWide()`** (above) owns *how wide* the viewport is, independent of
  selection.
- **`WorktreeDetailPage`** combines the two: wide renders `ResourceList` and
  the detail/timeline pane side by side in a `Grid` (selecting a resource
  swaps the right pane's content but keeps the list visible and highlights
  the selected card); narrow renders only one pane at a time — the
  `ResourceList` until something is selected, then a full-width
  `ResourceDetailPane` in its place (a "drilldown"), with a back control
  that clears the selection. Because both branches read the same
  `useSelectedResource()` state, resizing the window mid-selection changes
  *only* which of these two layouts is shown — the selection itself is
  untouched. `HomePage`'s narrow Worktrees/Timeline tab split (above) is the
  same `useIsWide()` pattern one level up, for the page as a whole rather
  than a single resource.
- **`ResourceDetailPane`** (`components/ResourceDetailPane.tsx`) is the
  pane rendered for a selected resource: a fuller `ResourceCard` (`variant="detail"`)
  above an `Activity` timeline filtered to just that resource (via
  `useWorktreeTimeline(path, { type, id })`, above), plus an optional
  `onBack` control shown only when the pane is a narrow-viewport drilldown.
  It is **deliberately a swappable slot**: a later Slack phase (see
  `docs/superpowers/specs/2026-08-21-worktree-ui-resource-selection-design.md`)
  will add a `resource.type === "slack"` branch here that renders the Slack
  thread view in place of the filtered timeline, while the surrounding
  responsive shell, selection state, and back control stay exactly as they
  are today — this component exists specifically so that branch has a
  single, already-wired place to land.

### Testing note: narrow-by-default and `setViewport`

`ui/src/test-setup.ts` installs a guarded global `matchMedia` stub
(`if (typeof window.matchMedia !== "function")`) that reports
`matches: false` for every query, so **every test renders the narrow layout
by default** unless it opts into wide. Wide-layout tests call
`setViewport("wide")` from `ui/src/testing/viewport.ts` (`setViewport("narrow")`
is also available, for explicitness) before rendering; `setViewport`
overwrites `window.matchMedia` directly rather than going through the
guard, so it works regardless of stub order. Because `test-setup.ts` runs
before every test file (it's wired as Vitest's `setupFiles`) and its stub is
guarded, the ~16 individual test files that each carried their own local
`matchMedia` stub (written before the global one existed) still have that
code, but it is now dead — the guard sees a real `matchMedia` already
installed and skips re-stubbing. Those per-file stubs are byte-identical in
behavior to the global one, so this changes nothing observable; they simply
weren't removed. If you touch one of those files, feel free to delete its
local stub, but leaving it is harmless.

## Focus vs primary (UI wording note)

The API and DB use the word **`primary`** (`resourceDTO.primary`,
`worktreeSummary.primary_count`/`primary_by_type`) for "resources central to
this worktree" as opposed to `related` (secondary/linked resources). The
**user-facing UI wording is "Focus"**, not "primary" — `ResourceList.tsx`
renders a "Focus" section for `items.filter(r => r.primary)`. This was a
deliberate rename at the UI layer only. **Do not "fix" the API/DB to say
"focus"** — the backend vocabulary (`primary`/`Related`) is intentional and
stable; only the presentation layer says "Focus."

## Rich resource cards

`ResourceCard.tsx` renders resource cards enriched from the watcher's cached
`resource_state` (`StateJSON`), via the `resourceDTO` enrichment fields
described above:
- **PR cards**: title, state (open/closed/merged, color-coded), review
  decision (approved/changes requested/review required), CI status, "new
  commits since review" badge, author, relative "updated" time.
- **Jira cards**: summary (shown as title), status, priority, issue type,
  labels, assignee, relative "updated" time.
- **Degraded ("minimal") card**: if `isEnriched(r)` is false (no enrichment
  fields present — the resource was never polled), the card falls back to a
  bare type badge + linked id (`MinimalRow`).
- **Slack cards** (`SlackCardBody`, Phase 4): channel name, author, and
  "started"/"active" relative timestamps (`created_ts`/`updated_ts`) sourced
  from the cached `resource_state` written by the `watcher/slack.Poll` poller
  in `pollAll` (see "Polling model" above) — `title`, `channel_name`, and
  `author` come from `m["title"]`/`m["channel_name"]`/`m["author"]` in that
  cached state JSON (`enrichResourceDTO`, `internal/webui/resources_api.go`).
  Unlike PR/Jira cards, Slack cards render even when not yet enriched — the
  card label falls back through `custom_name || title || id`
  (`ResourceCard.tsx`), so a never-polled thread still shows something
  useful (its custom name or raw resource id) rather than degrading to
  `MinimalRow`.

PR **author** and Jira **reporter** caching were added to the watcher library
in **v0.2.5** (`buildPRStateJSON`/`buildJiraStateJSON` in `~/git/watcher`).
Author is shown on PR cards; **reporter is cached but intentionally not
displayed** in the UI (a deliberate product decision, not an oversight — if
you want to show it later, it's already in the cached state JSON).

## Dev workflow

- `make dev` uses `mprocs` to run two live-reloading processes side by side:
  - `air -- ui --api-only` — the Go API server, hot-rebuilt on Go file
    changes (falls back to a manual `go build` + one-shot run + instructions
    if `air` isn't installed/on `PATH`).
  - `cd ui && npm run dev` — the Vite dev server on port 5175, proxying
    `/api/*` to `http://localhost:8475` (see `ui/vite.config.ts`).
  - On exit, `make dev` kills anything still listening on 8475 (not 5175 —
    a known minor gap, harmless since Vite's dev server exits with mprocs).
- `make build` is the production path: `build-web` (npm build → `ui/dist`)
  then `build-cli` (embeds `ui/dist` into the Go binary).

## Responsiveness

The UI must stay usable in narrow widths (e.g. a cmux split pane, ~380px) —
this was explicitly verified (Playwright, 380px and 1400px) during the Phase
2 polish round. Patterns to preserve when adding UI:
- `Grid.Col` uses responsive `span={{ base: 12, sm: N }}` so columns stack
  vertically below the `sm` breakpoint instead of squeezing side-by-side
  (see `HomePage.tsx`, `WorktreeDetailPage.tsx`).
- Badge/text rows use `wrap="wrap"` (Mantine `Group`) and `overflowWrap:
  "anywhere"` on long text (titles, resource names) so nothing forces
  horizontal scroll (see `EventRow.tsx`, `ResourceCard.tsx`).
- Verify no horizontal scrollbar appears at ~380px when adding new rows/cards.

## Slack thread view

Phase 3 folded a previously separate app (`slack-mini`) into worktree as a
per-worktree "Slack" tab on `WorktreeDetailPage`, alongside "Overview". This
section maps the folded-in code; see `docs/reverse-engineering/slack-web-api.md`
for Slack Web API internals (auth, endpoints, payload shapes, quirks) — read
it before touching `github.com/mturley/watcher/slack` or Slack rendering.

### Backend packages

- **`github.com/mturley/watcher/slack`** (in the watcher library, NOT this
  repo, as of Phase 4) — the Slack Web API client (`client.go`, `types.go`,
  `normalize.go`). Owns every Slack payload quirk; returns domain structs
  (`Message`, `User`, `Thread`, `Reaction`, `File`, `Attachment`,
  `Block`/`Element`) — callers never see raw Slack JSON. `normalize.go`'s
  `normalizeMessage` is the single per-message mapper. It also carries the
  library's Slack timeline poller (`slack.Poll`). Was worktree's
  `internal/slackapi` through Phase 3; lifted into the library in Phase 4 so
  the poller, worktree's UI, and (later) agent-handler share one canonical
  Slack domain. Changing it is cross-repo work (see `.claude/CLAUDE.md`
  "Watcher library").
- **`internal/slackpoller`** — the LIVE-TAB poller: polls Slack threads for
  changes and fans out `ThreadUpdate` events to subscribers (one in-memory
  polling loop per `(channel, threadTS)` key, only while a thread is open in
  the UI, for near-real-time SSE updates). This is **not** the watcher
  library's Slack poller (that's `watcher/slack.Poll`, run from
  `internal/webui/poller.go`'s `pollAll` for durable timeline events) and
  **not** worktree's PR/Jira poll loop — three distinct pollers, don't
  conflate them (renamed from slack-mini's `internal/watcher`, unrelated to
  `github.com/mturley/watcher`). It now consumes the library's `slack.Client`
  / `slack.Thread` types.
- **`internal/slackcreds`** — loads Slack token/cookie/workspace domain from
  the shared watcher config (`wconfig.Load` → `cfg.Slack()`) and builds a
  `github.com/mturley/watcher/slack.Client` (`slackcreds.Client()`).
- **`internal/slackurl`** — parses a Slack thread URL
  (`https://<workspace>.slack.com/archives/<channel>/p<ts>...`) into
  `(channel, threadTS)` and builds the canonical resource ID used to store it
  as a worktree resource (`ResourceID`).
- **`internal/setup/slack.go`** — the `worktree setup` step that walks the
  user through extracting their browser session token (`xoxc-...`) + cookie
  (`xoxd-...`) from Slack's web app dev tools, and writes them (+ workspace
  domain) to `~/.config/watcher/auth.yaml` via the watcher library's config
  package. `setup.BuildPlan` sets `ConfigureSlack` when Slack isn't yet
  configured or `wcfg.Slack()` errors.

### Slack creds (watcher `auth.yaml`)

Slack credentials are **not** a worktree-specific config file — they live
alongside Jira/GitHub creds in the shared watcher config at
`~/.config/watcher/auth.yaml` (`wconfig.DefaultPath()`), under a `slack:` key.
`SlackConfig` (added in watcher **v0.2.7**, pinned in `go.mod`) has three
fields: `token` (`xoxc-...`), `cookie` (the `d=` cookie, `xoxd-...`), and
`workspace_domain` (optional, e.g. `myworkspace` for
`myworkspace.slack.com`). Treat this file like a password — it's `0600`,
never committed, and tokens expire every 1-2 weeks (re-run `worktree setup`
to refresh).

### `webui.Server` wiring

`webui.Server` gains three Slack-related fields: `SlackClient
slack.Client` (from `github.com/mturley/watcher/slack`), `SlackPoller
*slackpoller.Poller`, `SlackDomain string`.
`runUI` (`cmd/ui.go`) attempts `slackcreds.Client()` at startup; on success it
wires all three fields and constructs the poller; on failure (no creds
configured) it leaves them `nil`/zero and logs "Slack not configured; Slack
tab will be unavailable" — the server still starts normally. Every
Slack-backed handler guards on `s.SlackClient == nil` (or, for the SSE
endpoint, `s.SlackPoller == nil` too) and calls `s.slackUnavailable(w)`, which
writes a `503` with body `"slack not configured; run worktree setup"`. There
is no send-allowlist (slack-mini had one; dropped in the fold-in — Slack
writes are otherwise unrestricted).

### HTTP API surface (Slack routes)

All registered in `registerAPI` alongside the existing routes, same JSON
conventions:

| Method | Path | Params | Response |
|---|---|---|---|
| GET | `/api/thread` | `channel`, `thread_ts` | `ThreadResponse` |
| POST | `/api/thread/mark-read` | body: `{channel, thread_ts}` | — |
| POST | `/api/thread/mark-unread` | body: `{channel, thread_ts}` | — |
| POST | `/api/thread/reply` | body: `{channel, thread_ts, text}` | — |
| POST | `/api/thread/react` | body: `{channel, thread_ts, message_ts, emoji}` | — |
| GET | `/api/slack-config` | — | `{workspaceDomain: string}` |
| GET | `/api/thread-events` | `channel`, `thread_ts` | SSE stream of `ThreadResponse` |
| GET | `/api/slack-avatar` | proxied avatar image params | image bytes |
| GET | `/api/slack-emoji` | proxied emoji image params | image bytes |
| GET | `/api/slack-file` | proxied file params | file bytes |
| GET | `/api/jira-icon` | `url` (issue-type icon on the configured Jira host) | image bytes |

**Image proxies.** All four share `handleImageProxyAuth(allowedHost,
authorize)` (`internal/webui/slack_proxy.go`): it pins the host, refuses
non-https, uses the SSRF-guarded transport from `image_proxy.go` (loopback,
RFC1918, link-local and the cloud-metadata address are all refused; 8 MiB
cap) and does not follow redirects. Only the credential differs per scheme —
`files.slack.com` gets the `d=` session cookie, `/api/jira-icon` gets Basic
auth from the watcher Jira config. Add a new proxy by passing an `authorize`
func, never by writing a second handler with its own security reasoning.

`/api/jira-icon`'s allowed host is derived from the configured Jira host
rather than a constant, so a cached state row carrying some other host's URL
cannot make the server fetch it.

**Correction (2026-08-25):** the received wisdom that Jira icon URLs need auth
— which is why agent-handler dropped real icons — was tested and does NOT hold
for `/rest/api/2/universal_avatar/...` on our instance: an unauthenticated
fetch returns the same bytes as the proxied one. A direct `<img src=iconUrl>`
would work there today. The proxy is kept because Jira Server/Data Center and
the older `/secure/viewavatar` and `/images/icons/issuetypes/` URL shapes do
require auth, and because proxying keeps the browser from calling the Jira
host (with whatever cookies it holds) on every resource card.

`ThreadResponse` (`internal/webui/slack.go`) is the enriched, normalized JSON
shape shared by `GET /api/thread` and the `/api/thread-events` SSE stream
(built once by `buildThreadResponse` so both stay consistent): channel,
channelName, threadTs, lastRead, latestReply, rootTs, unreadIndex,
currentUserId, messages (`[]MessageView`, each embedding `slack.Message`),
users (`map[string]slack.User`), emoji (`map[string]string`, filtered down
to only the names actually referenced in the thread). (`slack.*` types are
from `github.com/mturley/watcher/slack`.)

**Wire quirk:** `ThreadResponse`'s own top-level keys are camelCase (explicit
JSON tags), but the embedded `slack.Message` and its nested structs
serialize with Go's default PascalCase field names (e.g. `message.TS`,
`reaction.UserIDs`) since they don't carry JSON tags. The TS types in
`ui/src/api/slackApi.ts` mirror this split deliberately — don't "fix" it by
adding JSON tags to the library `slack` structs without checking every frontend
consumer. Nil slices/pointers marshal to `null`; the TS side guards for that.

`/api/thread-events` subscribes to `SlackPoller.Subscribe(channel, threadTS)`
and re-emits `buildThreadResponse` on every detected change, as an SSE
`event: message` with the JSON payload — separate from, and unrelated to, the
existing `/api/stream` timeline SSE endpoint.

### Slack threads as worktree resources

A Slack thread is a worktree resource with `type: "slack"` (see
`resources.Add` call sites, e.g. `cmd/add.go`), keyed by
`slackurl.ResourceID(channel, threadTS)`. `worktree add <slack-thread-url>`
parses the URL via `internal/slackurl`, adds it as a resource, and the
existing resource list / `SlackCardBody` render it as a lightweight resource
card (channel + thread pointer) alongside PR/Jira cards — no enrichment via
`watcher_resource_state` yet (that's cached PR/Jira poll state; Slack threads
are fetched live instead, not through the poll-and-cache path). **Phase 4**
will add Slack *timeline* events (a real watcher-library Slack poller/source
writing to `watcher_events`). Slack threads now enrich through the same
cached `watcher_resource_state` path as PRs/Jira, which is what lets
`SlackCardBody` show channel, author and started/active timestamps.

### Frontend: the Slack thread view

**Phase B (2026-08-24) removed the Overview/Slack tab split and the thread
rail entirely.** A Slack thread is now selected exactly like a PR or a Jira
issue — it is a resource card in the worktree's resource list — and the
selected thread renders in `ResourceDetailPane` where a PR/Jira resource
would show its filtered activity feed. The resource list plus that pane is
the whole detail-page body.

- `ResourceDetailPane` branches on `resource.type === "slack"` and renders
  `SlackThreadPane` (`ui/src/components/SlackThreadPane.tsx`) instead of the
  `ResourceCard` + filtered `TimelineFeed` body. The PR/Jira body lives in a
  sibling `TimelineBody` component **specifically so the timeline query is
  never issued for a Slack thread** — hooks can't be called conditionally, so
  the split is what keeps the fetch from firing.
- `SlackThreadPane` maps the resource into the `Tab` shape the ported Slack UI
  expects (`slackTabFromResource`, splitting the `<channel>:<ts>` id on its
  first colon), calls `useThread`, and renders `ThreadView`. It owns the
  "Slack not configured" (503) alert and surfaces a failed custom
  name/description save inline.
- **No resource summary card sits above a Slack thread** — `ThreadView`
  already carries its own title/description header, so a card would be
  duplicate chrome. (Phase C revisits this: it wraps that existing header in
  a card to match the PR/Jira detail card, rather than adding a second one.)
- The responsive drilldown is unchanged: on narrow viewports selecting a
  thread replaces the list, with the same "← all resources for worktree"
  back control.
- **Removed in Phase B:** `components/SlackTab.tsx`,
  `components/slack/ThreadRailLabel.tsx`, `hooks/useTabMetas.ts`, and
  `hooks/useWorktreeSlackThreads.ts` — all orphaned when the rail went.
  `useNow`, `deriveThreadMeta` and `fallbackTitle` were **kept**: `ThreadView`
  still uses them.
  - The rail's author/channel and started/active metadata was not lost — the
    Slack `ResourceCard` already shows it from cached `watcher_resource_state`,
    without `useTabMetas`' per-thread live fetch on a 30s interval.
  - The rail's **unread dot** has no equivalent yet and was deliberately
    dropped rather than kept alive by re-fetching every thread. See
    `docs/ui-feature-roadmap.md`.
- **Removed dead code (2026-08-20):** the old slack-mini global tab strip
  (`slack/TabBar.tsx`, `slack/AddTabModal.tsx`), the in-app open-thread-as-tab
  helper (`lib/openThread.ts`), and the sessionStorage-backed tab helpers in
  `state/tabs.ts` — only `Tab` and `defaultTabName` remain there. `@dnd-kit/*`
  deps are unused (kept for the deferred drag-to-reorder feature).

- Empty state: there is no Slack-specific empty state any more. A worktree
  with no Slack threads simply has no Slack cards in its resource list, and
  the list's own "Add resource" button accepts a Slack thread URL.
- Unconfigured state (backend returns `503`, detected via
  `isNotConfigured(thread.error)` in `SlackThreadPane` checking for `"503"` in
  the error string): a distinct `Alert` telling the user Slack isn't configured — distinguished
  from a per-thread load failure so the user isn't told to retry something
  that requires `worktree setup` instead.
- Ported slack-mini UI components live under `ui/src/components/slack/`
  (`ThreadView`, `Message`, `RichText`, `BlockKit`, `Attachments`,
  `FileAttachments`, `ReactionPill`, `ActionBar`, `Composer`, `TabBar`, plus
  modals) and shared libs under `ui/src/lib/` (`mrkdwn.tsx`, `emoji.ts`,
  `renderEmoji.tsx`) — see "Slack conventions" in `.claude/CLAUDE.md` for the
  don't-reinvent rendering rules these follow.
- **Custom thread name/description**: an "Edit thread details" modal
  (reachable from the thread header) calls
  `api.setResourceMeta({type: "slack", id, name, description})` →
  `POST /api/resource-meta`, then refetches resources. The `ThreadView` header and the Slack
  `ResourceCard` both prefer `resource.custom_name` over the raw `channel:ts`
  id when set. The Overview tab's Slack resource card does the
  same (prefers `custom_name`, falling back to the raw id) — a real
  first-message-derived fallback (instead of the raw id) is deferred to
  Phase 4 / the poller-rethink, since Slack resources aren't enriched via
  `watcher_resource_state` today.

## Known deferred items / extension notes

These are known limitations, intentionally deferred rather than fixed, from
the Phase 2 build ledger
(`.superpowers/sdd/2026-08-13-phase2-worktree-mantine-ui/progress.md`). Be
aware of them if your change touches the same area:

- **N+1 queries**: `worktreesWatching` + `resourceTitle` (timeline.go) call
  `watcherdb.SubscribersOf`/`GetResourceState` + `registry.List` per event
  row; `enrichResourceDTO` calls `GetResourceState` per resource row. Fine at
  current volume; batch these if event/resource counts grow significantly or
  if Phase 4 (Slack) adds a lot more resources.
- **SSE type-assertion fragility**: `handleStream` does `w.(http.Flusher)` to
  get a flusher. This breaks if any middleware wraps the `ResponseWriter`
  without also implementing `Flusher`. If Phase 5 (or anything) adds HTTP
  middleware in front of the mux, switch to `http.NewResponseController(w)`
  instead.
- **Resources not invalidated on SSE**: `useSSE` invalidates `["timeline"]`
  and `["worktrees"]` on `events_new`, but not `["resources", path]` — a
  detail page's resource cards won't auto-refresh on a new event without a
  poll-on-view trigger (page remount) or manual refresh.
- **Global timeline dedup by event id**: `writeTimelineRows` dedupes on
  `e.id` because today watcher writes exactly one resource per event. If
  Phase 4 (Slack) starts linking multiple resources to a single event, this
  dedup (and the underlying `SELECT DISTINCT` query) will need revisiting —
  likely a query-level `GROUP BY`/windowed subquery that picks one resource
  per event *before* the SQL `LIMIT` is applied (today, dedup happens
  *after* `LIMIT`, so a page could theoretically come back under-filled;
  not observable yet because it never fires).
- **Pagination not surfaced in the UI**: the API supports `before`/
  `next_cursor` (see the table above), and it's tested for the global
  timeline, but neither `HomePage` nor `WorktreeDetailPage` uses it — only
  the first page (`limit=100` default) is ever shown. Add "load more" /
  infinite scroll using `next_cursor` if this becomes a problem.
