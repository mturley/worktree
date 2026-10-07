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
  - `--local-only` — skip the HTTPS listener for other devices.
    `--api-only` implies it.
  - `--revoke-all-sessions` — delete every login session, then exit.
    Every device must log in again.
- Ports: **8475** production (Go server, serves API + embedded frontend),
  **5175** Vite dev server (`make dev`), which proxies `/api/*` to 8475.
- `runUI` (`cmd/ui.go`) opens the worktree DB (`wdb.Open()`), builds a
  `webui.Server`, starts the in-process poll loop (`srv.StartPolling(2 *
  time.Minute)`), opens the browser (unless `--no-open`/`--api-only`), then
  calls `srv.Start()`, which opens the loopback HTTP listener and, when
  remote access is configured, the HTTPS listener, then calls `srv.Serve`,
  which blocks until either listener stops.

### Authentication and remote access

**Listeners.** `Server.Start` opens plain HTTP on `127.0.0.1:<--port>`,
always loopback, and, when `Security.Remote()` (both `ui.tls` files set),
HTTPS on every interface at `ui.https_port`. Loopback stays HTTP so cmux
panes and the browser-open path need no certificate trust on this machine.
The HTTPS listener includes loopback because the `.local` name resolves to
127.0.0.1 here. `Start` and `Serve` refuse a nil or incomplete `Security`;
`Handler()` built without one skips the Host and session guards, which is
what in-process tests rely on.

**Guard order** (`Server.wrap`), outermost first:
1. `hostGuard` — the Host header's hostname must be `localhost`,
   `127.0.0.1`, `::1` or a `ui.allowed_hosts` entry. The port is ignored:
   rebinding changes the name, and the port varies between the two
   listeners and the Vite proxy (`Host: localhost:5175`). 400 otherwise.
2. `guardMutations` — JSON content type and same-origin for non-GET.
3. `requireSession` — every `/api/` path except `POST /api/login` needs a
   live session. It checks the prefix, not the route table, so new routes
   are covered automatically. A refusal is 401 with
   `X-Worktree-Login-Required: 1`; the UI shows the login screen only for
   401s carrying that header, because Slack handlers also return 401 when
   Slack's own credentials fail.

**Sessions** (`internal/uisession`, table `ui_sessions`). The cookie
`worktree_session` is HttpOnly, SameSite=Lax, Path=/, 30-day Max-Age, and
Secure when the login arrived over TLS (`r.TLS != nil`), decided per
request because one server has both listeners. Routes: `POST /api/login`,
`POST /api/logout`, `GET /api/session`, `GET /api/sessions`,
`POST /api/sessions/revoke {handle}`. The UI's Devices panel (home page
header) lists and revokes sessions.

**Setup** (`internal/setup/uiaccess.go`). Generates `ui.password` if unset
and prints it once. Offers remote access: detects the `.local` name and LAN
IP (`internal/netdetect`), falls back to asking for an IP, writes
`ui.allowed_hosts` (the certificate SANs and the Host allowlist, so they
cannot disagree) and `ui.tls`, and issues `ui-ca.pem`, `ui-cert.pem` and
`ui-key.pem` next to `config.yaml`. On later runs it offers renewal within
30 days of expiry, and a change of addresses. Either one creates a new CA
that must be reinstalled on the phone. `setup --uninstall` removes the
files and clears `ui.tls`/`ui.allowed_hosts`, keeping the password. The
config file is written 0600.

**Launchers.** An external launcher that still passes `--bind` or `--yes`
now fails with an error pointing at `worktree setup`. Remove those flags
from the launch command.

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
| GET | `/api/timeline` | `archived` (`"true"`/else false), `limit` (1-500, default 100), `before` (RFC3339 ts, exclusive upper bound), `resource_types`, `unread_only` (`"true"`: unread events only) | `timelineResponse` |
| GET | `/api/worktree-timeline` | `path` (required, worktree path), `limit`, `before`, `resource_type` + `resource_id` (optional, filters to one resource's events; must be supplied together or the request 400s), `resource_types`, `unread_only` | `timelineResponse` |
| GET | `/api/worktree-resources` | `path` (required) | `[]resourceDTO` |
| POST | `/api/worktrees/poll` | `path` (required) | `{"polled": bool}` |
| POST | `/api/resource-meta` | body: `{type, id, name, description}` | — |
| POST | `/api/resource-read` | body: `{type, id, through_ts}` | 204 No Content |
| POST | `/api/resource-resolve` | body: `{url}` | resolved link metadata |
| GET | `/api/resource-type` | `url` (required) | `{type, id}` or error if unrecognized |
| POST | `/api/worktree-resources/add` | body: `{path, url, related?}` | `resourceDTO` |
| POST | `/api/worktree-resources/remove` | body: `{path, type, id}` | 204 No Content |
| POST | `/api/worktree-resources/primary` | body: `{path, type, id, primary}` | 204 No Content |
| POST | `/api/worktree-resources/order` | body: `{path, focus: [{type,id}], related: [{type,id}]}` | 204 No Content |
| POST | `/api/worktrees/delete` | body: `{path, delete_branch, force_directory, force_branch}` | `{ok, needs_force, steps[]}` |
| GET | `/api/worktree-notes` | `path` (required) | `{notes, sync_cmux, updated_at?}`; empty notes when never saved |
| POST | `/api/worktree-notes` | body: `{path, notes, sync_cmux}` | the stored notes plus `cmux_sync` (`off`/`ok`/`skipped`/`failed`) and `cmux_error?`. 404 for an unregistered path, 413 over 64 KB |
| GET | `/api/cmux` | — | `{available, matches: {path: [{ref,title,color,selected}]}}`, matched server-side (symlink-resolving). Polled ~15s by one shared TanStack query. |
| GET | `/api/cmux-groups` | — | workspace groups + `cmux.NamedColors`; fetched only when a create/select modal opens |
| POST | `/api/cmux/select` | body: `{path, ref}` (see handler) | selects a workspace, then always `osascript` activate |
| POST | `/api/cmux/create` | body: `{path, ...}` (see handler) | creates a workspace via `cmux.BuildLayout` from the worktree's current resources |
| GET | `/api/cmux/tree` | `path` (required) | `{available, workspaces: [{id, ref, title, color?, selected, layout?, panes?, error?}]}` for the workspaces matching `path` (same matching as `/api/cmux`); one `cmux tree` per workspace; a per-workspace failure sets `error` instead of failing the request. Each tab in `panes[].tabs[]` carries `unread` (omitted when false). Polled 5s, only while the details card's cmux tab is open. |
| POST | `/api/cmux/rename` | body: `{id, title}` | trimmed-empty title → `clear-name`; replies `{ok, error?}` |
| POST | `/api/cmux/color` | body: `{id, color}` | empty → `clear-color`; else a `cmux.NamedColors` name or `#RRGGBB` (400 otherwise) |
| POST | `/api/cmux/focus-tab` | body: `{id, surface}` | select workspace → `focus-panel` → activate; unguarded |
| POST | `/api/cmux/close-tab` | body: `{id, surface, type, title}` | guarded: re-reads the tree, `{ok:false, stale:true}` unless the tab still matches |
| POST | `/api/cmux/move-tab` | body: `{id, surface, type, title, pane, anchor?: {surface, type, title, position}}` | guarded (tab and anchor); same pane → `reorder-surface`, other pane → `move-surface` |
| POST | `/api/worktrees/create` | drives `internal/worktreenew` | `{ok, confirm?, steps[]}` — a pending question is HTTP 200 + `confirm`, never an error status |
| GET | `/api/repos` | — | registry repos, newest worktree first |
| GET | `/api/repo-dotfiles` | `repo` (required) | gitignored dotfiles that repo would copy into a new worktree |
| GET | `/api/stream` | `tab`, `route`, `visible` (all optional; see "Notifications") | SSE stream (`text/event-stream`) |
| POST | `/api/notify` | body: `{path, type?, id?, on, tab?}` (no type/id = the worktree-wide toggle) | `{ok, mode}`; turning ON sends a test notification. 400 for a link or a half-given resource, 404 for an unregistered worktree or untracked resource |
| POST | `/api/tabs/presence` | body: `{tab, route, visible}` | 204; 404 for an unknown tab or another session's |
| POST | `/api/tabs/ack` | body: `{tab, notification_id, shown}` | 204; 404 for an unknown tab, another session's, or a notification nobody awaits |
| GET | `/api/link-image` | `url` (required), `type` (required: `favicon` or `preview`) | image bytes or 404 |

### `internal/worktreenew` step semantics

`POST /api/worktrees/create` and the `worktree add` CLI both drive
`internal/worktreenew`'s runner, whose step-tracking conventions matter to any
new consumer:

- **`Options.DeclineReset` is distinct from `ResetToPR == false`.** The former
  means "the user was asked whether to reset to the PR and said no"; the
  latter means "not asked yet." Collapsing the two makes the runner re-raise
  the same confirmation forever, and a client that gives up on that loop
  strands a worktree git has already created — on disk, unregistered, holding
  no port range, invisible to the rest of the tool. This field has to be
  threaded through every layer that can answer a confirmation (the CLI
  driver, the HTTP request struct, the modal); it was missed at each of those
  layers once during development.
- **A step's `pending` status is overloaded.** It means both "in progress
  right now" (a slow step is recorded `pending` when it *starts*, so the CLI
  can show a spinner) and "never reached" (`finish()` pads every unreached
  step as `pending` at the end of a run). The first `pending` step in the
  list during a mid-flow run is the in-flight one; every `pending` step after
  it is genuinely unreached. Any new consumer of the step list must
  disambiguate these two meanings itself — there is no separate flag.
- **`record` replaces an existing step with the same key rather than
  appending**, so the step list is one-entry-per-key by construction. This is
  why a consumer can treat it like a map keyed by step, and why a duplicate
  key from a re-invoked call site can never produce a second entry.

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
  unread         bool      // omitempty; ts newer than the resource's read cursor (always false for Slack)
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

// unread state (omitempty; absent when nothing is unread):
unread_count              int       // events newer than the resource's read cursor
unread_through_ts         string    // ts of the newest of those events (same snapshot); never for Slack
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

## Resource card ordering

The worktree detail page's resource cards are user-orderable within the Focus
and Related groups, and the order is stored server-side so it follows the user
between devices and shows up in the CLI listings too.

**Storage.** One nullable `sort_order` column on `worktree_primary`, the table
that already holds this worktree's opinion about a resource. Group and rank
change together, in one row, in one transaction — which is the whole point,
since a rank only means anything relative to the other members of its group.

**NULL means "never placed by hand"**, and `resources.Load` sorts unranked
rows *after* ranked ones (tie-broken by subscription `created_at`, as before).
Three things fall out of that, all deliberate:

- an upgraded database looks exactly as it did until the user drags something,
  so the migration needs no backfill;
- a newly followed resource lands at the bottom of its group with no rank
  written at all;
- `Load` also puts Focus before Related, because per-group ranks only read
  correctly if the groups stay apart. This changed the CLI's flat listing
  order (`worktree info`, `worktree resources list`) to match the web UI's.

**Two ways to change groups, on purpose different:**

| Path | Lands | Owner |
|---|---|---|
| Focus/Related toggle (web, CLI, agent-handler) | bottom of the new group | `resources.SetPrimary` → `setGroupAndPlace` |
| Cross-group drag (web UI) | exactly where it was dropped | `resources.SetOrder` |

A drag states a position; a toggle does not. `resources.Add` re-adding a
tracked resource with the other flag counts as a toggle, since `Add`
overwrites `is_primary`. Re-setting the group a resource is already in is a
no-op for order — the UI fires the toggle with no confirmation step, so a
repeat must not shuffle anything.

**The endpoint is declarative:** `POST /api/worktree-resources/order` states
the full membership of both groups rather than a single move. It is therefore
idempotent and replayable, and two devices dragging at once resolve to
last-writer-wins instead of to an ambiguous relative move. `SetOrder` is
forgiving about a client whose view is behind: a tracked resource named in
neither list keeps its group and is appended to that group's end, and a key
that is not tracked at all is ignored rather than failing the whole reorder.

**Frontend.** Every card carries a grip handle at all times — no mode, no
hint text. Each is a `SortableResourceCard`, which wraps the ordinary
selectable `ResourceCard` and passes the handle in through its `dragHandle`
prop. Only the handle starts a drag (it is the sortable's activator node), so
the rest of the card behaves exactly as it always has:

- **Click** anywhere but the handle selects. A drag needs 4px of travel on the
  handle, so pressing it and letting go is not a drag either.
- **Touch** needs no long press: a swipe that starts anywhere but the handle
  still scrolls the page. `touch-action: none` sits on the handle alone, which
  is what lets a touch drag start there without the browser claiming the
  gesture as a scroll.
- **Keyboard** reordering works, because the handle is a real button *beside*
  the card's select button rather than a wrapper around it, so dnd-kit's
  `attributes` can go on it: Space/Enter picks the card up, arrows move it,
  Space/Enter drops it.
- **The click after a drop:** the dragged card follows the pointer, so the
  release can land on it and the browser clicks it. dnd-kit's pointer sensors
  already swallow that click (a capture-phase listener on `document`, armed
  only once a drag activates and removed 50ms after it ends), so there is no
  suppression of our own. The test for it runs on fake timers for that reason:
  on real ones the listener outlives the test and eats the next test's click.

**The handle's hover menu.** Hovering a grip opens a small menu: the "Drag to
reorder" hint, Move to top / Move to bottom (`moveToEdge` — within the card's
own group, never reclassifying), and the same Focus/Related switch as the
detail card. A reclassification there is shown at once as the bottom of the
new group, matching what `resources.SetPrimary` will do server-side. It is a
controlled `Popover`, not a `Tooltip` (never interactive) and not a
`HoverCard`, because of what it has to guarantee — all of it measured in a
real browser, where jsdom's geometry-free hover had passed every version:

- **Reachable.** The pointer crosses a gap between handle and menu that
  belongs to neither, and the menu closes if it lingers there past the close
  delay. Mantine's defaults (12px gap, 150ms) lost the menu on a slow,
  deliberate move; the gap is now 4px plus the arrow, and the grace 400ms.
- **One at a time.** Adjacent cards' menus overlap, and moving to the next
  handle left both open — a lingering menu over its neighbour's could catch
  a click meant for it. `HoverCard.Group` would fix this, but Mantine 7 does
  not export it, so `useHoverMenu` keeps a single open id for the whole list:
  a 300ms delay to open, instant switching while one is already open.
- **Out of the way of a drag.** Picking a card up closes any open menu at
  once, and none opens until the drag ends.

**Dragging between groups** follows dnd-kit's multiple-containers pattern.
Each group is its own `SortableContext`, and a sortable only opens a slot for
cards that belong to its context — so the moment a dragged card is over the
other group, `onDragOver` moves it into that group's list
(`crossGroupPreview`), and the target group animates a slot open just as the
source group does. The drop then only has a within-group move left to make.
Three supporting pieces, each there for a reason:

- `crossGroupPreview` places the card before or after the hovered card by
  comparing their vertical centres, which is the only way to reach the
  bottom of a group (`applyDrag`'s `placement`). Within a group, arrayMove
  semantics still apply, matching what the sortable strategy previews.
- `resourceCollisions` aims at cards, never at a non-empty group container:
  a container spans its cards, so its centre sits among them and can win
  `closestCenter`, leaving no card to land next to. An empty group under the
  pointer wins outright, since it has no card to aim at.
- For one frame after each cross-group move, collision reports the dragged
  card itself ("stay put"). The move shifts the layout under the pointer,
  and without the hold the collision can resolve straight back to the group
  the card just left, bouncing it.

The drag's starting list is kept, so Escape restores any trip into the other
group, and a drop back where the card started saves nothing.

**Auto-scroll is off** (`autoScroll={false}`). Left on, a short drag scrolled
the page to its bottom and then ran away with the sticky list column: the
dragged card's `transform` pushes it past the column's bottom, which inflates
the column's scrollable area, so auto-scroll kept chasing it (measured:
`scrollTop` 858 in a column whose real maximum was 137) before snapping back
on drop. Programmatically scrolling a sticky overflow container under a
transformed element is also what desynced WebKit's hit-testing from its
painting — every button's clickable area drawn ~20px from where it was hit,
until something forced a repaint. The lists fit on screen; the wheel still
scrolls during a drag if one ever doesn't.

Groups are `useDroppable` containers as well as lists, so a card can be
dragged into an empty group; an empty group only renders, as a drop zone,
while a drag is in progress. `ui/src/lib/resourceOrder.ts`'s `applyDrag` holds
all the list arithmetic as a pure function, keeping the dnd-kit wiring thin.

Each drop persists immediately (the call is idempotent, so there is no unsaved
state for a closed tab to lose). The optimistic list wins over the `items` prop
for as long as it is set, which stops a background refetch from yanking the
list mid-drag or snapping it back before the save lands. It is cleared by the
first `items` change with no drag or save in flight — in practice, the refetch
each save triggers once it settles. A failed save reverts it and shows an
inline alert.

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

### Delete worktree (`worktree_delete_api.go`)

`POST /api/worktrees/delete` — body `{path, delete_branch, force_directory, force_branch}`.

**Deletion is multi-phase.** `internal/worktreedel` owns the sequence and both
the CLI and this endpoint drive it, so they cannot drift. git may refuse to
remove the directory, and may refuse to delete an unmerged branch; each refusal
returns **200** with `needs_force` naming the step, never an error status —
"git wants confirmation" and "the delete broke" must stay distinguishable.
There is no server-side session: granting a force re-posts the whole request,
so every step is idempotent and already-done work reports as `skipped`.

Two further rules the sequence depends on:

- **`remove_directory` failure aborts the run and leaves the registry row
  intact.** Unregistering a worktree still on disk would strand it — invisible
  to the tool but still holding its port range. Other failing steps (cleanup)
  do not abort.
- **Branch deletion is opt-in on both surfaces**: the UI checkbox starts
  unchecked and the CLI prompt defaults to no. Removing a worktree destroys
  nothing a branch does not still hold, so the branch is never deleted without
  an explicit yes.

### Worktree notes (`internal/notes`, `worktree_notes_api.go`)

Free-text notes per worktree, edited in the detail card's Notes section and
stored in the worktree-owned `worktree_notes` table (keyed by registry path).

- **Read-only by default.** Notes render as GitHub-flavoured Markdown
  (`NotesMarkdown.tsx`: react-markdown + remark-gfm, raw HTML ignored — never
  add rehype-raw) until "Edit notes" swaps in the textarea; "Done editing",
  Esc, or collapsing the section flushes pending edits and returns to the
  rendered view. The cmux sync checkbox shows only while editing.
- **Task checkboxes are clickable in the read-only view**, like a GitHub
  description. Each rendered task item knows its source offset (react-markdown
  `node.position`, passed to the checkbox via context); `lib/taskList.ts`
  `toggleTaskAt` flips exactly that `[ ]`/`[x]` marker, or returns null —
  leaving the text alone — if no marker is there. The edit saves at once
  through `useWorktreeNotes.editNotes`, which applies it to the latest draft.
- **Notes outlive the registration.** `registry.Unregister` does not touch
  `worktree_notes`, so a worktree recreated at the same path gets its notes
  back.
- **Own endpoint, not a field on `/api/worktree-info`**, so a git status
  refetch never overwrites notes being typed and a save costs no git
  subprocess.
- **Autosave** lives in `ui/src/hooks/useWorktreeNotes.ts`: the local draft
  is the truth while it has unsaved edits; server data is adopted on load and
  afterwards only while the draft is clean and the server's `updated_at` is
  newer than the last save (so a slow refetch cannot roll a save back). Every
  save writes its result into the TanStack cache — the card remounts on each
  visit, and would otherwise start from the first load's cached copy. Saves are debounced
  (`NOTES_SAVE_DEBOUNCE_MS`), at most one is in flight, and edits made during
  a save go out in a follow-up save. Pending edits are also sent when the
  section collapses and on unmount/`beforeunload` (a `keepalive` fetch). The
  card is keyed by path in `WorktreeDetailPage` so a draft never leaks to
  another worktree.
- **cmux description sync** (opt-in, per worktree, stored as `sync_cmux`): on
  every save with sync on, the server lists cmux workspaces, matches the path
  with `cmux.Match`, and — only when exactly ONE matches — sets that
  workspace's description by its UUID `id` (refs are index-based and shift).
  Empty notes clear the description. The notes are committed BEFORE cmux is
  touched, so a cmux failure is reported in `cmux_sync`, never as a failed
  save. The sync is one-way; unchecking it leaves the description as it is.

### Unread (`internal/unread`, `internal/webui/unread.go`)

One read cursor per RESOURCE in `resource_read_cursor` (a worktree-owned
table), compared against `watcher_events.ts`. Unread is `ts > last_read_ts`,
strictly greater.

**The user's own events are never unread.** `internal/selfid` stores the
user's account ID per source in `self_identity` (GitHub `databaseId`, Jira
`accountId`, Slack user ID), resolved by `worktree ui` at startup and retried
every 10 minutes for any source that failed. Every unread query appends
`selfid.NotMineSQL`, which drops events whose `(source, author_id)` matches.
That covers `Summaries`/`Counts`, `SlackCounts` and the timeline's
unread-only clause. `unreadIndex.IsUnread` applies the same rule in Go with
`selfid.IsMine`. This is a query-time filter, and the cursor never moves on
its own: an event someone else wrote before the user's reply stays unread
until marked read, and `unread_through_ts` covers only others' events.
Events without an `author_id` (recorded before watcher v0.10.0, or
authorless, such as CI) always count. Requires watcher ≥ v0.10.0, which
added `watcher_events.author_id`.

**Not the same model as agent-handler's.** Handler tracks unread per
*subscriber*, so each session has its own read state. This is per *resource*
and shared: marking a PR read in one worktree clears its dot in every worktree
tracking it.

**Slack threads have no cursor row — they read Slack's.** Slack owns a read
cursor for the current user and two systems must not both claim authority over
one thread, so every seeding path skips `slack` and the endpoint and CLI
command reject writes to it. The READ side, though, mirrors Slack's cursor:
the poller caches `last_read` beside `has_unread` in `watcher_resource_state`
(watcher `v0.8.1`), and `unread.SlackCursors` loads it into `unreadIndex`
alongside the worktree-owned ones.

**Two cursors, two clocks.** A Slack cursor is a Slack message ts and is
compared against `watcher_events.external_ts`; every other cursor is compared
against `ts`. That inverts this package's usual rule (`ts`, never
`external_ts`) on purpose — the timestamps live in different clocks and
Slack's cursor only means anything against Slack's own. The hazard that rule
prevents, read and unread interleaving under a divider, does not arise for
Slack: a thread's own feed is the rendered thread view, which draws its
divider from the live API, and the interleaved timelines mark events
individually. `slackTSGreater` parses both sides as floats rather than
comparing strings, because Slack ts values grow a digit
(`9999999999.x` sorts above `10000000000.x` lexically).

**Read-state writes refresh the cache before answering.** Every unread
surface except the thread view reads the poller-cached `has_unread` and
`last_read`, so a mark that only wrote to Slack left cards, dots, badges and
mark-all-read's Slack count stale until the next background poll reached the
thread. `/api/thread/mark-read`, `/api/thread/mark-unread` and
`/api/thread/reply` therefore call `refreshSlackThread` after Slack accepts
the write: if a worktree tracks the thread, it is re-polled synchronously via
`pollOne`, and the client invalidates `worktrees`/`resources`/`timeline` when
the response lands. Untracked threads have no cache and are skipped.

**The dot vs. the divider.** `has_unread` answers "does this thread have
anything new?" and drives the resource dot; `last_read` answers "which
messages are new?" and drives `TimelineEvent.unread` on individual replies.
Writes still go to Slack, via the thread view's "Mark thread read".

**Slack threads carry `unread_count` too.** `unread.SlackCounts` counts a
thread's events newer than Slack's `last_read` — the same events the
timelines mark unread, via the shared `unread.SlackNewerSQL` predicate (also
used by the global timeline's unread-only filter). `unreadIndex.fill` then
ties the count to `has_unread`, Slack's own verdict: 0 when Slack says read,
whatever stale events say, and at least 1 when Slack says unread, since an
unread message the poller never recorded as an event (an unread root, say)
still counts. So a thread's number and its dot always agree, and Slack
threads count in the card badges, the worktree totals and the tab title like
everything else. `fill` is the one place any endpoint sets `unread_count`.

**Seeding.** A resource with no cursor row reads as zero unread, so rows must
actually get written or a resource would never earn its first dot:
`resources.Add` seeds new subscriptions, and `internal/db`'s migration
backfills existing ones at their newest event. Both are INSERT OR IGNORE, so a
second worktree subscribing to a resource someone already reads inherits that
cursor rather than resetting it.

**`unreadIndex` is request-scoped**, for the same reason `eventEnricher` is:
cursors move from other processes (`worktree resources mark-read`,
agent-handler's shell-outs) writing this same SQLite file, which this server
cannot observe. Build one per request; never hang it off `Server`.

**`worktreeSummary.has_unread`** aggregates the question across ALL of a
worktree's resources, related ones included, and drives the card's left-border
accent. Deliberately server-side: related resources are counted in the
response but never listed, so a client folding over `focus_resources` alone
would miss their unreads.

**The tab itself is an unread surface** (`ui/src/hooks/useUnreadFavicon.ts`).
Mounted once beside `useSSE` in `App.tsx`, it folds the worktree list through
`lib/unreadBadge.ts` and, while anything is unread, blinks the favicon between
`/favicon.svg?v=2` and `/favicon-unread.svg` (the same tile with a blue dot)
and badges the title — `(3) worktree`, or `• worktree` when the unread has no
countable tally behind it (only an older cached response now — Slack threads
count at least 1 while unread). It has no
polling of its own: the `["worktrees"]` query the pages already use is
invalidated by the stream, so the tab starts on the event and stops on the
mark-read.

The blink ticks from a Worker (`lib/blinkTicker.ts` + `blinkWorker.ts`), not
`setInterval`. Chrome throttles a chained page timer to roughly once a minute
once a tab has been hidden for five minutes — precisely the tab this feature
exists for. Worker timers are exempt. The `setInterval` fallback is for
anywhere a module Worker cannot be constructed, jsdom included, which is what
the tests exercise. The blink deliberately does NOT check
`document.hidden`: it is meant to be caught peripherally, on the focused tab
as well.

**`through_ts` is client-supplied.** The endpoint never substitutes a
server-side `MAX(ts)` — events arriving between render and click must stay
unread rather than being swallowed by a button that promised to clear a
specific number. The cursor only moves forward, so a stale replay is a no-op.

**Mark all read** (`ui/src/components/MarkAllReadButton.tsx`, on the worktree
page's unified Activity header) keeps that promise across resources. Its
modal lists one checkbox per resource type with unreads, all checked by
default — "Mark 3 GitHub events in 2 PRs as read", "… Jira events in … issues",
"… Slack messages in … threads" — and marks only the checked types. GitHub/Jira
resources each post `/api/resource-read` with their `unread_through_ts`,
which comes from `unread.Summaries`, the same query as `unread_count`, so it
is the newest of exactly the events counted, never "now". Slack threads post
`/api/thread/mark-read` — a write to Slack itself — through their cached
`updated_ts`, the latest message as of the poll that flagged them.

**Show unread only** (`UnreadOnlyToggle`) is one UI-wide choice
(`useUnreadOnly`): persisted in localStorage under `worktree.unreadOnly`, shared
by every toggle in the tab via `useSyncExternalStore`, and carried to other
tabs by the `storage` event. The home page's toggle sits beside the worktree
sort control; the worktree page's beside Follow resource. When on it hides
worktrees without `has_unread` and resources without `hasUnread` (empty states
"No worktrees with unread events" / "No resources with unread events"), and
narrows the two unified feeds to unread events. A selected resource that the
filter hides — typically one just marked read — is deselected by the
stale-selection effect, with `replace`. The single-resource feed is never
narrowed: one cursor keeps its unread events together at the top under the
divider. Reordering a filtered resource list saves the FULL order
(`mergeVisibleOrder`), because the server appends any card an order omits to
the end of its group, which would sink every hidden card. The feeds filter SERVER-side via `unread_only`, since the
feeds page with a limit. The worktree timeline filters in memory on
`te.Unread`, IsUnread's own verdict. The global timeline pages in SQL, so
`unreadOnlyClause` re-implements IsUnread as a predicate — both clocks,
Slack compared numerically — and
`TestGlobalTimelineUnreadOnlyMatchesIsUnread` pins the two together. Change
either and you must change the other.

### SSE (`/api/stream`)

No params. On connect, sends nothing but flushes headers. Every 5s, checks
`MAX(ts)` on `watcher_events`; if it advanced since the last tick (or since
connect), emits `event: events_new\ndata: {}\n\n`, then always emits `event:
heartbeat\ndata: {}\n\n`. The frontend treats `events_new` purely as a
cache-invalidation signal (no payload).

A stream opened with `?tab=<id>&route=<path>&visible=1|0` also registers that
tab for browser notifications, and may carry `event: notification` messages
addressed to it; see "Notifications" below.

Every stream also carries `event: cmux_focus` (`{"workspace_id","path"}`)
whenever cmux focuses a different workspace; see "Follow cmux focus" under
"cmux integration".

## Notifications

Per-worktree "Notify on all" and per-resource "Notify on new events" toggles.
New events for a notifying resource become a desktop notification: through
`cmux notify` when the server can reach cmux, otherwise from exactly one
browser tab per login session.

**Storage — `internal/notifyprefs`, table `worktree_notify`.** A row means
on; the row with an empty `resource_type`/`resource_id` is the worktree-wide
toggle. Keyed by `wdb.Subscriber(path)`. The two kinds are independent, so
turning "Notify on all" off restores the per-resource choices underneath.
`resources.Remove`/`RemoveAll` delete the matching rows (every
`registry.Unregister` caller also calls `RemoveAll`). DTOs expose them as
`worktreeSummary.notify_all` and `resourceDTO.notify` (explicit only; the UI
shows `notify || notify_all`).

**Notifier — `notifier.go`, `notify_scan.go`.** `StartNotifier` (started by
`worktree ui`, 5s) keeps its own cursor over `watcher_events`; it does not
hook the pollers, which write straight to the DB. The cursor is the newest
`ts` plus the `(id, ts)` rows already read, and every pass re-reads a 30s
lookback window behind it: `ts` has one-second resolution, and the watcher
stamps it from the wall clock before its write commits, so a write that waited
on the SQLite lock can land behind a cursor that already moved on. Keyed by
`(id, ts)` because the watcher reuses a CI bundle's ID and restamps its `ts`.
It starts at `MAX(ts)` with the window pre-marked seen, so a restart never
replays a backlog, and it advances whatever delivery does — nothing is
retried. A cursor that failed to initialise is never read with (it would
start from the beginning of time); each pass retries the initialisation
instead. As a backstop against any flood, a pass that would fire more than
`notifyMaxPerPass` (5) notifications sends one "New activity — N resources
have new events" summary instead, targeting the worktree if they share one
and nothing (home page / untargeted cmux) if not. A busy tab stream is waited on (up to the ack timeout) rather than
treated as a decline, since one pass can produce several batches at once. `watch_started`, `watcher_error`,
`ci_pending` and `ci_workflows_pending` never notify, and neither do the
user's own events (`selfid.NotMineSQL`; see "Unread"). Matching goes through
`resources.Load`, so only resources the worktree actively tracks count. One
batch per (worktree, resource): title = the resource's key + custom name or
title, subtitle = worktree name, body = newest event's title + "(+N more)".

**Delivery mode** is chosen once per process: `cmux.IsAvailable()` (not
`InPane` — the server drives cmux from wherever it runs) → `cmux notify
--workspace <id>` for the worktree's matched workspace, so clicking the banner
switches to it; with no match it posts untargeted (the UI server's own
workspace). Failures are logged and dropped. Otherwise browser mode. The mode
is `notify_mode` on `GET /api/session`.

**Browser mode — `tabs.go`.** Each tab makes a random ID per page load
(`lib/tabId.ts`) and opens the stream with `tab`, `route` and `visible`, so
registration happens in the same request (a presence POST racing it would
404). `POST /api/tabs/presence` updates route/visibility on navigation,
`visibilitychange` and `focus`. Per batch and per session, candidates are
ordered: that worktree's detail page, then the home page, then any tab;
visible before hidden, then most recently active. The first gets the
`notification` message and must ack: `shown:false` (no permission / no API)
moves on at once, silence moves on after 5s — a frozen background tab keeps
its stream open but never runs the handler. Each offer has its own
notification ID, so a late ack can't be mistaken for the current one, and the
`tag` (`worktree:<path>|<type>:<id>`) makes the browser replace rather than
stack a duplicate. A reconnect re-registers the same tab ID; the old stream's
deferred cleanup only removes its own registration. Tab IDs are bound to the
session that registered them.

**Test notification.** `POST /api/notify` turning a toggle on delivers
"Notifications on" through the active path (browser: the caller's session,
the caller's tab first). Links are refused: they are never polled.

**UI.** `NotifySwitch` is the shared switch; in browser mode it asks for
permission on the enabling click, and while on it says so when THIS browser
blocks or hasn't allowed notifications (with an Allow button) — a toggle set
from another device does nothing here until allowed. The worktree page header
has "Notify on all" beside "Show unreads only"; the detail card has "Notify on new
events" ("Notify on new messages" for a Slack thread), disabled with an explanation while "Notify on all" is on.
`NotifyBell` marks list cards: filled = explicit, outlined/dimmed with a stack
badge = inherited from "Notify on all". The home page shows one inherited bell
on the worktree card when "Notify on all" is on, else an explicit bell at the
end of each notifying focus resource's first line. `useSSE` shows a received
notification and acks; clicking it focuses the tab and navigates to the
worktree with the resource selected (`lib/browserNotify.ts`).

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
- **Components** (`ui/src/components/`): `WorktreeList`,
  `WorktreeSortControl` (see "Worktree list sorting" below), `TimelineFeed`,
  `EventRow`, `ArchivedToggle`, `ResourceList` (splits into Focus/Related by
  `r.primary`, selection-aware), `ResourceCard` (see "Rich resource cards"
  below), `WorktreeCard` and `ResourceDetailPane` (see "Responsive resource
  selection" below). Every on/off switch (`UnreadOnlyToggle`,
  `ArchivedToggle`, `NotifySwitch`, `FollowCmuxToggle`) renders `Toggle`, the
  one place their size is set — use it rather than Mantine's `Switch`.
- **Lib** (`ui/src/lib/`): `resourceSummary.ts` (builds the "2 PRs, 3 Jira
  issues · 2 related resources" summary string from `primary_by_type` +
  `related_count`), `worktreeSort.ts` + `worktreeSortPref.ts` (see "Worktree
  list sorting" below), `relativeTime.ts`, `resourceKey.ts` (see
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

### Worktree list sorting

The home page's worktree list is sorted client-side. The server returns
`/api/worktrees` in registry order (`ORDER BY repo, path`) and nothing about
the sort choice reaches it.

- **Modes** (`lib/worktreeSort.ts`): cmux order, Latest activity, Created,
  Name, Unread first. Created and Name each have their own
  ascending/descending toggle (`hasDirection`), remembered separately so
  switching between them never flips the other. Every mode breaks
  ties by Name, and missing or unparseable values (`latest_event_ts: ""`, a
  legacy non-RFC3339 `created_at`) sort last in either direction.
- **cmux order** uses `index` on each `/api/cmux` workspace: its position in
  `cmux workspace list`, which is the sidebar order. It is deliberately not the
  ref number, since refs stop following the sidebar once workspaces are moved.
  A worktree with several workspaces takes its earliest. The query refetches
  every 15s, so the list follows drags in cmux.
- **Created** uses `created_at` on the worktree summary, the registry value
  verbatim.
- **Persistence** (`lib/worktreeSortPref.ts`): `localStorage`, per browser,
  keys `worktree.home.sort.mode`, `worktree.home.sort.createdDir` and
  `worktree.home.sort.nameDir`.
  `useWorktreeSort` listens for `storage` events, so a change in one tab
  re-sorts the browser's other open tabs immediately.
- **Default** (`resolveSortMode`): cmux order when cmux is reachable,
  otherwise Latest activity. A saved "cmux" shows Latest activity while cmux
  is unreachable, without overwriting what was saved. While the cmux query is
  still pending and the answer matters, the mode is `null`: the list stays in
  server order and the picker is not rendered, which avoids a visible re-sort
  on load.
- **Tests under Node 25**: Node's own experimental `localStorage` global
  shadows jsdom's with a method-less object; `ui/src/test-setup.ts` puts
  jsdom's real Storage back.

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
- **`WorktreeDetailPage`** combines the two: wide renders `ResourceList`
  (sticky) and a right-hand pane side by side in a `Grid`. With nothing
  selected the split is 6/6 and the right pane is the worktree's unified
  Activity feed, with the same GitHub/Jira/Slack `SourceFilter` toggles as
  the home page's feed; selecting a resource narrows the split to 4/8 and
  swaps the feed for `ResourceDetailPane`, keeping the list visible (only
  the spans change, so it stays mounted) and highlighting the selected card. Narrow with
  nothing selected shows a Resources/Activity tab bar (like the home page's
  Worktrees/Activity tabs); selecting a resource replaces it with a
  full-width `ResourceDetailPane` (a "drilldown"), with a back control that
  clears the selection. The active tab is page state, so backing out of a
  drilldown returns to the tab you left. Because both branches read the same
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

## Link resources

A link resource tracks an arbitrary web page: worktree resolves its metadata
(title, description, favicon, preview image) once at add time and renders it in
an iframe. Unlike PR/Jira resources, links are **never polled and produce no
events**, so they never appear in any Activity feed and have no unread state.

**Link ID:** A link's ID is its **normalized URL** — scheme and host are
lowercased, the default port for the scheme is dropped, and the fragment is
stripped, but path and query are preserved exactly. This normalization ensures
that `https://github.com/example/repo` and `HTTPS://GITHUB.COM/example/repo`
resolve to the same ID.

**Metadata storage:** Link metadata lives in `watcher_resource_state` (the
same table as PR/Jira cached state), but worktree writes it directly rather
than through a poller. This is the only place worktree writes a `watcher_*`
row for a type the watcher library does not know about; the table is a generic
`(type, id) -> json` cache with no schema coupling to a specific source.

**No polling:** `pollAll` in `internal/webui/poller.go` dispatches per type by
name (PR, Jira, Slack); a type it never names is never polled. This is the
entire mechanism — there is no link-specific code in the poller that you could
accidentally activate. Adding a `"link"` case to that switch would break this
invariant and must never happen.

**Iframe sandboxing:** The frontend embeds links in an `<iframe>` with
`sandbox="allow-scripts allow-same-origin"`. The `allow-same-origin` flag
normally permits a sandbox escape when the frame can reach its embedder via
same-origin navigation. The `ui/src/lib/linkEmbed.ts` same-origin guard
**is what makes this safe**: it refuses to embed a URL that resolves to a
host reachable from worktree's own origin, so the frame is never actually
same-origin with the embedder and the escape route is blocked.

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
| GET | `/api/slack-autocomplete` | `trigger` (`@`/`:`/`#`), `q`, `channel` | `{results: AutocompleteItem[]}` |
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

### Composer autocomplete (`GET /api/slack-autocomplete`, `internal/webui/autocomplete.go`)

One endpoint behind all three composer triggers, dispatched on the `trigger`
query param:

- **`@`** — with an empty `q`, returns only the three specials
  (`@here`/`@channel`/`@everyone`) with no Slack call. With a non-empty `q`, it
  fires `SearchUsers` and `SearchUserGroups` concurrently (mirroring Slack's
  own client behaviour) and appends the specials after them. A user-search
  failure is fatal to the request; a group-search failure is logged and
  swallowed so the user list still comes back.
- **`:`** — makes **no `emojis/search` call**. It filters the custom-emoji map
  the server already caches (`slack.go`'s `emoji()`), sorted by match length
  then name so results are deterministic. Values that are still an
  `alias:<name>` indirection are skipped: `emoji.list` derefs only one level,
  so an alias whose target is a *standard* emoji stays literal, and it is not
  a URL (see the `emoji.list` section of the RE doc). The Unicode half of the
  emoji menu is matched client-side from node-emoji
  (`ui/src/lib/emoji.ts`'s `standardEmojiNames`, ranked the same way) and
  merged in by `localCandidates` — the server only ever knows about custom
  emoji, so without that half `:smi` finds nothing in a workspace with no
  custom `smile`. This path goes through the same TTL cache + single-flight
  as the other two triggers, and `emoji()` negatively caches a failed
  `emoji.list` for 60s: it is called on every debounced `:` keystroke, and
  caching only successes meant a failing `emoji.list` produced a fresh Slack
  call per keystroke.
- **`#`** — `SearchChannels`, empty `q` short-circuits to `[]`.

Every result is an `AutocompleteItem` (`{kind, id, label, detail?, avatar?,
imageUrl?, token}`, `kind` one of `user`/`group`/`special`/`channel`/`emoji`).
`token` is the load-bearing field: it is the exact, ready-to-insert mrkdwn
(`<@U…>`, `<!subteam^S…>`, `<!here>`, `<#C…|name>`, `:name:`) built by one set
of Go functions (`userToken`/`groupToken`/`specialToken`/`channelToken`/`emojiToken`)
with table tests, so mention encoding lives in exactly one place and the pill
the user sees cannot disagree with what gets posted.

**One deliberate exception:** candidates that never round-trip through the
server — thread participants and groups the thread view already has loaded,
plus the @here/@channel/@everyone specials — are built locally so the menu can
paint before any network round trip. `ui/src/components/slack/composer/tokens.ts`
mirrors the same builders for exactly that purpose; its test table mirrors the
Go table case for case, and each side carries a comment pointing at the other.
Anything the server returns already carries its own `token` and is used
as-is — `tokens.ts` is never consulted for remote results.

**Errors are JSON, and `degraded` means the lookup FAILED.** All three error
statuses (400 bad trigger, 401 auth, 502 upstream) go out through
`writeError` as `{"error": …}`. On the client, `slackApi.autocomplete()`
returns `null` for a failure and `[]` for a successful empty result (an abort
— the normal end of a superseded keystroke — also resolves `[]`), and
`useAutocomplete` raises the "workspace search unavailable" hint only on
`null`. Conflating the two made a query that simply matched nobody look like
a broken Slack session.

**A stored server answer is tagged with the query it answers.** `remote` state
carries its `(trigger, query)` and is ineligible for display until those match
the live ones. Clearing it on every keystroke would work too but blanks the
remote half of a menu the user may be arrowing through; leaving it untagged
was a real bug — the previous query's results stayed in the menu, highlighted,
through the debounce plus a Slack round trip, so Enter posted a mention of the
wrong person.

**Lookups run on a detached context.** The single-flight leader's `fn` gets
`context.WithoutCancel` plus a timeout (`detachedLookupContext`), because it
runs on behalf of every waiter: inheriting the leader's request cancellation
meant the composer's own debounce aborting one keystroke failed the lookup for
everybody waiting on it.

**Hybrid lookup and one-time reorder.** `useAutocomplete` (`composer/useAutocomplete.ts`)
computes local candidates synchronously from thread state
(`composer/candidates.ts`'s `localCandidates`) so the menu paints on the first
keystroke, then debounces (150ms) a server request and merges the response in
with `mergeCandidates`: dedup on `(kind, id)`, local entries win. Consequence
by design — the menu can reorder **once**, when remote results land, and never
again after that; the highlighted item is tracked by `(kind, id)` (see
`itemKey` in `AutocompleteMenu.tsx`) rather than by list index, specifically so
a merge landing mid-keystroke cannot move the selection out from under the
user's arrow keys.

**The TTL + single-flight cache is a requirement, not an optimisation.**
`autocompleteCache` (`internal/webui/autocomplete_cache.go`) sits in front of
every Slack-backed lookup with a 60s TTL: concurrent callers for the same key
block on one in-flight call rather than each firing their own request.
`docs/reverse-engineering/slack-web-api.md` records that bursts of
autocomplete-shaped calls got the user's own session token revoked twice in
twenty minutes — this cache (plus the frontend debounce) is what keeps
repeated prefixes and two panes on the same thread from multiplying Slack
traffic. Errors are deliberately not cached, so a transient failure doesn't
blank the menu for a minute.

The cache key (`autocompleteCacheKey`) is **length-prefixed**
(`"<len>:<field>"` per field, concatenated), not delimiter-joined. A plain
separator (`"|"`, `"\x00"`) can still collide: `q` and `channel` come straight
off a URL query string, and `net/url` will happily decode a percent-escaped
occurrence of any byte — including the delimiter itself — into the field
value. Length-prefixing makes the key unambiguous regardless of what bytes the
fields contain.

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

### Composer architecture (`ui/src/components/slack/Composer.tsx` + `composer/`)

The reply composer is a Lexical editor, not a plain `<textarea>`, so it can
render mentions as pills while still producing literal mrkdwn:

- It uses Lexical's `PlainTextPlugin`, not `RichTextPlugin` — formatting
  (`*bold*`, `_italic_`, `` `code` ``) is inserted as literal mrkdwn characters
  by the toolbar, never as rich formatting marks.
- Mentions are atomic `MentionNode` pills. The load-bearing trick is that
  `MentionNode.getTextContent()` returns the mrkdwn **token** (`<@U…>`, etc.),
  not the display label — which is what makes serializing the whole message
  exactly `$getRoot().getTextContent()`, with no separate serializer to drift
  out of sync with what the pills display.
- Escape-dismissal of the autocomplete menu needs to identify one specific
  trigger *occurrence* so it stays dismissed while the user keeps typing, but
  reopens for a genuinely different trigger. That identity lives in
  `composer/suppression.ts` as a pure re-anchoring function
  (`reanchorOffset`/`reanchorSuppression`) — it's the fourth design tried, the
  first three each had a degenerate input (an empty query, or a trigger at
  offset 0) that matched everything. It has one documented, accepted
  limitation: typing a new trigger character immediately before an already-
  dismissed one resolves the anchor onto the wrong occurrence (identical
  characters carry no positional information a diff can use to tell them
  apart). See the file's own comments and `suppression.test.ts` for the exact
  case.

## cmux integration

`internal/cmux` wraps the `cmux` CLI to show and switch/create workspaces from
the web UI (worktree cards get a workspace section above the title). A few
things constrain any change here:

- **Path matching happens in Go, not TypeScript**, because it has to resolve
  symlinks: `cmux.Match(workspaces, paths)` canonicalizes both sides exactly
  once via `Abs → EvalSymlinks → Clean`, then keys the result map by the
  caller's **original**, uncanonicalized path — a path with no match is
  simply absent from the map, never present with an empty slice. Frontend
  code must treat a missing key and an empty match list as the same thing.
- **No cmux failure ever produces a 5xx.** `GET /api/cmux` degrades to
  `{available: false}` on any error (cmux not installed, not running inside a
  cmux surface, CLI error) and the workspace card section renders nothing —
  there is no error state for "cmux isn't available," only an absence.
- `GET /api/cmux` is polled ~15s by a single shared TanStack query (not one
  per card) since it returns the full path→workspaces map in one call.
  `GET /api/cmux-groups` is comparatively expensive and is only fetched when
  a select/create modal actually opens.
- `POST /api/cmux/select` always follows a successful select with an
  `osascript` activate — there is no "select without switching focus" mode.
- Every server-side workspace lookup goes through `Server.listCmuxWorkspaces`,
  which honors the `cmuxList` test seam.

### Unread mailbox on workspace titles (`cmux_unread.go`, `cmux/unread_prefix.go`)

A cmux workspace whose worktree has unreads gets `📬 ` (`cmux.UnreadPrefix`)
in front of its title, and loses it once nothing is unread. The prefix exists
**only in cmux**:

- **Reconciled, not edge-triggered.** `StartCmuxUnreadSync` (every 5s, started
  in `cmd/ui.go`) compares the wanted state with the titles cmux reports. It
  has to work this way because unread state also changes in other processes
  (`worktree resources mark-read`, agent-handler) that this process never
  hears about. The trade-off: if you delete the 📬 by hand in cmux while
  unreads remain, it comes back on the next pass.
- **"Unread" is exactly `has_unread` from `/api/worktrees`**: any focus or
  related resource, regardless of notification toggles. It uses the same
  `ix.fill` and `resourceHasUnread`.
- **Only the prefix is touched.** A rename happens only when the prefix state
  is wrong, and it rewrites `custom_title` with just the prefix added or
  removed. **Auto-titled workspaces (no `custom_title`) are skipped**:
  prefixing one would set a custom title and freeze cmux's own name.
  Workspaces not open on a registered worktree are never touched.
- **The UI never sees it.** `Workspace.DisplayTitle()` strips the prefix, and
  every title DTO is built from it. `handleCmuxRename` looks up the
  workspace's current title and puts the mailbox back in front of what the
  user typed. Clearing the name still runs `clear-name`, which makes the
  workspace auto-titled, so it loses the mailbox.
- `Server.cmuxTitleMu` serializes the sync pass and the rename handler. Both
  read a title and then write one, and without the lock either could write
  back a title the other had just replaced.
- A title the user writes that starts with `📬 ` can't be told apart from
  one the sync added.

### Follow cmux focus (`cmux_focus.go`, `cmux/focus.go`, `CmuxFollower`)

A per-tab toggle (home page worktree toolbar, after Sort by; worktree
header before the Switch cmux button) that makes the tab
open whichever worktree cmux switches to. Rendered only when `/api/cmux` says `available`, i.e. the server runs
inside cmux.

- **Source:** `StartCmuxFocusWatch` runs `cmux events --name
  workspace.selected --name window.focused --reconnect` for the server's
  life, restarting it after 5s if it exits. `cmux.ParseFocusEvent` takes the
  workspace ID from the payload (falling back to the top-level field) and
  drops deselections. `window.focused` covers switching between cmux windows.
- **Dedupe + resolve:** the hub publishes only when the focused workspace ID
  changes — `window.focused` fires every time cmux comes forward. The path is
  the first registered worktree (registry order) open in that workspace, via
  `cmux.Match`, or `""`.
- **Fan-out:** every `/api/stream` subscribes; sends never block, so a stalled
  stream just misses a change. `useSSE` hands `cmux_focus` to
  `lib/cmuxFocusBus.ts` (and invalidates `["cmux"]` so "Current" updates).
- **Client:** the toggle's value is sessionStorage
  (`worktree.followCmuxFocus`, `hooks/useFollowCmux.ts`) — following is one
  tab's role, so tabs don't all jump together. `CmuxFollower`, mounted once
  inside the Router, navigates only when following, the path is non-empty and
  differs from the page's worktree. Leaving a worktree page by any other
  route (back link, browser back, a notification, a link to another
  worktree) turns following off; the follower tells its own navigations
  apart by recording the path it is about to open.
- **Turning it on:** the toggle fetches `GET /api/cmux/focused` (the
  workspace `cmux workspace list` reports as selected, resolved the same way)
  and hands it to `CmuxFollower` as an ordinary focus change, so the tab goes
  where cmux already is under the same rules.
- **Unsaved changes:** components holding typed-but-unsent input register
  through `useUnsavedChanges(isDirty)` (`lib/unsavedChanges.ts`): the Slack
  composer and the add-resource, new-worktree, create-workspace,
  edit-resource-details and delete-worktree modals. Worktree notes don't —
  they save on unmount. The cmux tab's inline rename doesn't either: it
  cancels on blur, so the prompt taking focus would discard it whichever
  button was chosen. With anything registered, a non-dismissable prompt asks
  "Discard and follow" or "Stay and stop following"; it uses `zIndex=1000`
  so it sits above a page modal whose overlay would otherwise eat the clicks.

### The details card's cmux tab (`cmux_tabs.go`, `CmuxPanel`, `PaneDiagram`)

- **Data:** `cmux tree --json --workspace <uuid>` parsed by `cmux.Tree` into a
  layout tree (pane leaves, two-child splits with a ratio) plus panes and
  their tabs. Tab types are open-ended (`terminal`, `browser`, `markdown`, …)
  and browser tabs can have no URL.
- **Addressing:** workspaces by UUID (`workspace:N` is the less stable
  handle); tabs by `surface:N` — `tree` gives tabs no UUID. Inputs are
  regex-checked before any exec: surface/pane refs against `surface:\d+` /
  `pane:\d+`, and the workspace `id` itself against a UUID pattern, in every
  POST handler (rename, color, focus-tab, close-tab, move-tab) before it can
  reach `--workspace <id>` or `workspace select <id>`.
- **Stale guard (close, move):** refs come from a poll up to 5s old, so the
  request carries the tab's type and title as the user saw them and the
  server re-reads the tree first; titles are compared after stripping a
  status glyph at either end (`◐`/`◑` at the start, pi's emoji at the end),
  since agents animate them.
  A mismatch is `{ok:false, stale:true}` and nothing happens; the UI
  refetches and the user retries. A millisecond race remains (no
  compare-and-close in cmux).
- **cmux behaviour to remember:** `close-surface` echoes a ref that is not
  the one it closed — never parse `OK …` output. Reorder/move select the
  moved tab and focus its pane even with `--focus false`, and closing the
  selected tab picks a neighbour — cmux moves the user's selection/focus on
  its own for both. Moving a pane's last tab out closes the pane. Reads can
  lag writes: a `tree` straight after a move once returned the old layout.
  `focus-panel` selects a tab but ALSO switches the user's active workspace
  ~250ms later — it is never used to restore focus, only `focus-tab` (an
  explicit user click) calls it.
- **Focus/selection restore (close, move):** since cmux jumps the selection
  and pane focus on its own, `handleCmuxCloseTab`/`handleCmuxMoveTab` put the
  user's prior state back afterwards: before acting, they record the touched
  panes' selected tabs (close: the closed tab's pane; move: source and
  target) plus the originally focused pane; after acting, they poll `tree`
  (`restorePollInterval`, default 150ms, up to `restorePollTimeout`, default
  1s) until it reflects the change, then restore each pane's recorded
  selection — by ref, or by type + normalised title if the ref changed and
  the match is unique — via an **in-place `reorder-surface`** (selects a tab
  and focuses its pane without switching the active workspace, unlike
  `focus-panel`). The originally focused pane is restored LAST, so it ends up
  the one actually focused. If the tree never reflects the change, or a
  restore reorder fails, the request still answers `{ok:true}` — the
  close/move itself already succeeded.
- **No pinned-tab state:** cmux 0.64 exposes pinning per workspace only.
- **Unread dot:** `tabs[].unread` comes from one `cmux rpc notification.list`
  call per `handleCmuxTree` poll (best-effort — a failure there just leaves
  every tab's `unread` false, never a 5xx), matched to tabs by
  `(workspace_id, surface_ref)`; focusing a tab in cmux is what marks its
  notifications read.
- **UI:** the card's `Tabs` run with `keepMounted={false}` and Notes /
  Environment opt back in, so only `CmuxPanel` unmounts when hidden — ending
  its poll and resetting its "Show N more tabs" expansion. Close is
  optimistic, the same way move is: `useCmuxMove`'s `close`/`move` share one
  in-flight counter (so the 5s poll pauses for either) and one settle delay,
  `CMUX_SETTLE_MS` (1s) — the cache is updated at once via `applyClose`
  (remove the tab; a neighbour stands in for its pane's selection; an emptied
  pane is dropped and its split collapsed) or `applyMove` (the moved tab
  lands unselected, since the server's restore — not cmux's own jump — is
  what the optimistic update is modelling), then cmux's truth is re-read
  after the settle delay on success, or at once on failure/staleness.

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
