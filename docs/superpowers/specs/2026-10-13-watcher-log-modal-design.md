# Watcher log modal + per-resource poll status — design

Date: 2026-10-13
Status: approved in brainstorming, pending spec review

## Problem

Poller failures are nearly invisible in the web UI. `WatcherErrorMark` shows a
red triangle only while a poller is *currently* failing (its last error is newer
than its last success), so a transient failure — e.g. GitHub returning a 504 at
09:18 and recovering at 09:22 — is visible for one poll interval and then gone.
The `watcher_error` events the pollers write are filtered out of every timeline
query (`internal/webui/timeline.go`) and skipped by notifications. And a failure
affecting a single resource inside an otherwise successful run (a Slack
`thread_not_found`, a PR missing from the GitHub batch, a `processPR` error) is
masked entirely, because the same run then records poller-wide success.

The only record of what the pollers did is the `worktree ui` process's stderr.
Error messages also embed whole response bodies — GitHub's 504 page, base64
images included — into `watcher_poller_status.last_error_message` and therefore
into the existing tooltip.

## Goal

A **watcher log** button next to every activity refresh button opens a modal with
two tabs:

- **Log** — a live, persisted log of watcher activity: poll lifecycle, one
  summary line per HTTP call (with a trimmed error body on failure), and
  per-resource failures.
- **Resource Status** — every watched resource, when it was last successfully
  polled, and the outcome of its last poll, with a tooltip of details.

Success: after a transient outage, opening the modal shows what failed, when,
for which resources, and what the server said — even after `worktree ui`
restarts.

## Constraints

- **No added traffic on normal page views.** All new data loads only after the
  modal opens; closing it stops all polling. The global `/api/stream`,
  `/api/watchers`, and existing page queries are unchanged.
- **Cross-repo.** Schema, recording, and pruning live in the watcher library
  (`~/git/watcher`), released as **v0.13.0** and re-pinned here, per this repo's
  CLAUDE.md "Watcher library" rules. The change is additive for agent-handler:
  no `Poll` signature changes.
- **The log is bounded.** Pruned on every poll to 7 days and 50,000 rows.
- **No secrets in the log.** Endpoint paths only (no query strings — Jira JQL,
  tokens); request headers are never recorded.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| What "including responses" means | Summary line per HTTP call; on non-2xx, a sanitized, ≤500-char error body. No full bodies. A verbose mode can be added later without redesign. |
| Log lifetime | Persisted in the DB, pruned (7 days / 50k rows). |
| Modal scope | Contextual and widenable: resource pane → that resource; worktree page → that worktree; home → everything. "Show all" drops the scope. |
| Where logging lives | The library owns schema, writing, and pruning (same pattern as `watcher_events` / `watcher_poller_status`). worktree only reads. |
| Live updates | Modal polls the log endpoint with an `after_id` cursor every 3 s while open. No SSE changes. |
| "Last updated" | Time of the resource's last *successful poll*. The resource's own `updated_at` goes in the tooltip. |
| Activity header error mark | Stays poller-wide (unchanged). Making it per-resource would need status data on every page view. |

## Part 1 — watcher library (`~/git/watcher`)

### Schema

New migration (bump the schema version); add all three tables to
`managedTables` and `managedColumns` in `db/schema.go`.

```sql
CREATE TABLE IF NOT EXISTS watcher_resource_poll_status (
	resource_type      TEXT NOT NULL,
	resource_id        TEXT NOT NULL,
	last_attempt       TEXT,          -- RFC3339
	last_success       TEXT,
	last_error         TEXT,
	last_error_message TEXT,          -- sanitized
	last_detail        TEXT,          -- JSON, see below
	PRIMARY KEY (resource_type, resource_id)
);

CREATE TABLE IF NOT EXISTS watcher_poll_log (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- also the pagination cursor
	ts          TEXT NOT NULL,                      -- RFC3339Nano
	source      TEXT NOT NULL,                      -- github | jira | slack
	level       TEXT NOT NULL,                      -- info | warn | error
	kind        TEXT NOT NULL,                      -- poll | http | resource
	message     TEXT NOT NULL,
	method      TEXT,
	endpoint    TEXT,                               -- host + path, no query
	http_status INTEGER,
	duration_ms INTEGER,
	bytes       INTEGER,
	error_body  TEXT                                -- sanitized, ≤500 chars
);
CREATE INDEX IF NOT EXISTS idx_watcher_poll_log_ts ON watcher_poll_log (ts);
CREATE INDEX IF NOT EXISTS idx_watcher_poll_log_source ON watcher_poll_log (source, id);

CREATE TABLE IF NOT EXISTS watcher_poll_log_resources (
	log_id        INTEGER NOT NULL REFERENCES watcher_poll_log(id) ON DELETE CASCADE,
	resource_type TEXT NOT NULL,
	resource_id   TEXT NOT NULL,
	PRIMARY KEY (log_id, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_watcher_poll_log_resources_res
	ON watcher_poll_log_resources (resource_type, resource_id, log_id);
```

`AUTOINCREMENT` (not plain rowid) so ids are never reused after pruning — the
UI's `after_id` cursor must stay monotonic. Pruning deletes join rows explicitly
as well, so correctness does not depend on `PRAGMA foreign_keys`.

`last_detail` JSON:

```json
{"ok": false, "duration_ms": 12300, "http_status": 504,
 "events_emitted": 0, "note": "GitHub API error: Unicorn! · GitHub"}
```

All fields optional. For GitHub, `duration_ms`/`http_status` are the batch
call's (shared by every PR in it).

### `db` functions

- `RecordResourcePoll(conn, r watcher.Resource, ok bool, message string, detail ResourcePollDetail) error`
  — upserts the row; always sets `last_attempt` and `last_detail`; sets
  `last_success` when ok, else `last_error` + `last_error_message` (sanitized).
- `GetResourcePollStatuses(conn, resources []watcher.Resource) (map[key]ResourcePollStatus, error)`
- `InsertPollLog(conn, PollLogEntry) (id int64, error)` — writes the row and its
  resource tags in one transaction.
- `QueryPollLog(conn, PollLogQuery) ([]PollLogEntry, error)` — filters: sources,
  min level, resource set (via the join table), `AfterID`, `BeforeID`, `Limit`.
  Returns newest first, each entry with its resource tags. The resource-set
  filter also includes untagged `kind=poll` rows whose source is among the
  sources of the filtered resources (see Part 2).
- `PrunePollLog(conn, maxAge time.Duration, maxRows int) error` — deletes rows
  older than `maxAge`, then the oldest rows beyond `maxRows`, plus their join
  rows.

### `polllog` package

- `Sanitize(body []byte, contentType string) string` — if the body is HTML (by
  content type or a leading `<`), return its `<title>` text (entities decoded)
  if present, else tag-stripped text; collapse whitespace; cap at 500 chars with
  an ellipsis. Also applied to messages written to
  `watcher_poller_status.last_error_message`, fixing the existing tooltip.
- `WithResources(ctx, rs ...watcher.Resource) context.Context` and the matching
  getter.
- `Transport{Base http.RoundTripper, Conn *sql.DB, Source string}` — a
  `RoundTripper` that times the call, reads the resource tags from the request
  context, and writes one `kind=http` row: `method`, `endpoint`
  (`req.URL.Host + req.URL.Path`), `http_status`, `duration_ms`, `bytes`
  (`resp.ContentLength`, or the counted body length when it is unknown), and on
  non-2xx a sanitized `error_body` read from a buffered copy of the body
  (the response body handed back to the caller is unchanged). Level `info` for
  2xx, `error` otherwise and for transport errors (message = the error). A log
  write failure is logged to the poller's `*log.Logger` and never fails the
  request.
- `Write(conn, source, level, message string, rs ...watcher.Resource)` —
  convenience for `kind=poll`/`resource` rows; exported for consumers (worktree
  uses it for "not configured" warnings).

### Poller changes

Each poller's HTTP client is wrapped with `polllog.Transport`, and each request
is built with a context carrying its resources. Call sites:
`github/graphql.go` (batch query, per-PR follow-up queries),
`jira/client.go`, `slack/client.go` (both `Do` sites).
`github/summaries.go` (`FetchPRSummaries`) is the linked-resources fetch, not
polling, and is not instrumented.
`validate.go` calls (credential checks) are **not** instrumented — they run from
`worktree setup`, not polling.

`slack.Client` is also used outside polling (the live-tab `slackpoller`, the
composer, thread views). Instrumentation must be opt-in on the client so
interactive Slack traffic is not logged as watcher activity: add a non-breaking
`(*HTTPClient).WithTransport(rt http.RoundTripper) *HTTPClient` (today `New`
hard-codes `&http.Client{Timeout: 20s}`), and have the slack `Poll` build its
client with the instrumented transport. Jira and GitHub construct a fresh
`http.Client` per call inside poller-only code paths, so they are wrapped
directly.

Each `Poll`:

1. Writes `kind=poll`, `info`: "github poll started: 12 resources".
2. Records per-resource outcomes with `RecordResourcePoll` and, for failures, a
   `kind=resource`, `error` log row tagged with the resource:
   - **GitHub batch failure** → every PR: error, note = sanitized error.
   - **PR absent from batch response** (today a stderr WARNING only) → error,
     "no data returned (unresolvable repo, deleted PR, or no access)".
   - **`processPR` error** → that PR: error.
   - otherwise → ok, with `events_emitted`.
   - **Jira / Slack** → per resource, as each fetch/process succeeds or fails.
   - **Invalid resource ID** (parse failure) → error.
3. Writes `kind=poll`: "github poll finished: 3 events, rate limit 4870/5000"
   (`info`), or "github poll failed: …" (`error`).
4. Calls `PrunePollLog(conn, 7*24*time.Hour, 50000)`.

Existing `logger.Printf` stderr lines, `watcher_error` events, and
`watcher_poller_status` recording are unchanged (apart from sanitizing).

### Library tests

- `Sanitize`: GitHub HTML error page → `Unicorn! · GitHub`; HTML without title;
  JSON body; whitespace collapse; 500-char cap; non-UTF-8 input.
- `Transport` against `httptest.Server`: 200 and 504 rows written with correct
  fields; resource tags from context; query string never stored; response body
  still fully readable by the caller; transport error logged.
- Per-poller recording (existing poller test harnesses): batch failure marks all
  PRs; missing PR marked; `processPR` failure marks one; Jira and Slack
  per-resource failure and success; lifecycle rows present.
- `QueryPollLog`: each filter, cursor both directions, resource filter includes
  same-source poll rows only.
- `PrunePollLog`: by age, by count, join rows removed, ids not reused.
- Migration from the current schema version; `managedColumns` collision check.

## Part 2 — worktree backend (`internal/webui`)

New file `watcher_log_api.go`, routes registered in `server.go`:

### `GET /api/watchers/resources`

Query: `worktree=<path>` (optional), `resource=<type>:<id>` (optional). When
both are given, `resource` wins (the narrower scope); `worktree` is ignored.

- Scope: unscoped → all active subscriptions; `worktree` → that worktree's
  subscriptions, matched through `wdb.Subscriber(path)` (never a raw
  `"worktree:"+path` concat); `resource` → just that resource.
- Response:

```json
{"resources": [{
  "type": "pr", "id": "owner/repo#123", "url": "…",
  "name": "custom name | title | id",
  "worktrees": ["/Users/…/.worktrees/foo"],
  "status": "ok | error | never",
  "last_attempt": "…", "last_success": "…", "last_error": "…",
  "error_message": "…",
  "detail": {"ok": false, "duration_ms": 12300, "http_status": 504,
             "events_emitted": 0, "note": "…"},
  "resource_updated_at": "…"
}]}
```

- `status`: `never` when no row; `error` when `last_error > last_success` (or no
  success); else `ok`. Sorted errors first, then by name.
- Name resolution reuses the resource card's precedence (custom name → cached
  title → id); share the existing helper rather than reimplementing it.

### `GET /api/watchers/log`

Query: `worktree`, `resource`, `source` (repeatable), `level` (`info` default |
`warn` = warn+error | `error`), `after_id`, `before_id`, `limit` (default 200,
max 500).

- Resolves the scope to a resource set as above and passes it to
  `QueryPollLog`. Untagged poll-lifecycle rows are included for the sources
  present in that set — a PR's view shows GitHub poll start/finish, not Jira's.
- Response: `{"entries": [...], "has_more": bool}`, newest first. Each entry
  includes its tagged resources as `{type, id, name}`, so the UI can show names
  without another request.
- Invalid parameters → 400.

### `pollAll`

The "github/jira/slack not configured; skipping N resources" branches also call
`polllog.Write(conn, source, "warn", …)` so a missing token is visible in the
modal. `pollOne` needs no change.

### Backend tests

Handler tests for both endpoints: scoping by worktree (including a symlinked
path, to exercise `wdb.Subscriber` canonicalization), by resource, unscoped;
status derivation; sort order; both cursors and `has_more`; level and source
filters; poll-row inclusion rule; bad params → 400.

## Part 3 — UI (`ui/src`)

### `WatcherLogButton`

`components/WatcherLogButton.tsx`. An `ActionIcon` (`IconListDetails`, tooltip
"Watcher log") matching `RefreshWatchersButton`'s size and variant. Props:
`scope: { worktree?: string; resource?: { type: string; id: string; name: string } }`.
Holds the open state; renders `WatcherLogModal` **only while open**. Placed
immediately beside `RefreshWatchersButton` in:

- `pages/HomePage.tsx` → `scope={}`
- `pages/WorktreeDetailPage.tsx` → `scope={{ worktree: path }}`
- `components/ResourceDetailPane.tsx` → `scope={{ worktree: path, resource }}`

### `WatcherLogModal`

`components/watcherlog/WatcherLogModal.tsx`, Mantine `Modal` size `xl`. All
queries live inside it, so unmounting on close stops every request.

Header: "Watcher log" plus a scope chip — "This PR: *name*" / "This worktree" /
"All resources" — with a **Show all** button that clears the scope for this
modal session.

**Log tab** (`LogTab.tsx`):

- Rows: time (`HH:mm:ss`, full timestamp in a tooltip), source icon, level dot
  (dimmed / yellow / red), message. HTTP rows render
  `POST api.github.com/graphql → 504 · 12.3 s · 1.2 KB`.
- Error rows with an `error_body` or resource tags are expandable, showing the
  body (monospace) and the tagged resource names.
- Toolbar: source `SegmentedControl` (All / GitHub / Jira / Slack) and an
  **Errors & warnings only** switch. Changing a filter resets the list.
- Live: initial fetch of the newest 200; then every 3 s fetch `after_id=<max>`
  and prepend. When scrolled to the top, new rows appear in place; when
  scrolled away, a "N new" pill appears and jumps to the top when clicked.
- **Load older** at the bottom fetches `before_id=<min>` while `has_more`.
- Empty state: "No watcher activity recorded yet."

**Resource Status tab** (`ResourceStatusTab.tsx`):

- Rows: source icon, name (links to the resource URL, new tab), "Updated *2m
  ago*" from `last_success` (or "Never"), status icon — green check (`ok`), the
  same red triangle as `WatcherErrorMark` (`error`), grey dash (`never`).
- Tooltip on the status icon: last attempt, outcome, duration, HTTP status,
  events emitted, error message, and "Resource last changed …"
  (`resource_updated_at`).
- Refetches every 10 s while the modal is open.
- Empty state: "No resources are being watched."

API client functions and types go in `api/` next to the existing watcher
status calls.

### UI tests (Vitest)

- Button renders without making requests; opening fetches both endpoints with
  the right scope params; closing stops the intervals.
- Scope chip text per scope; Show all refetches unscoped.
- Log tab: renders HTTP and lifecycle rows; expands an error row; filters reset
  and refetch; `after_id` merge prepends without duplicates; "N new" pill when
  scrolled; Load older.
- Resource Status tab: the three status icons; tooltip contents; error-first
  order.

## Documentation

- `docs/web-ui-architecture.md`: new "Watcher log" section (routes, DTOs,
  scoping rule, the "only while open" constraint).
- `CLAUDE.md` project-structure notes: mention the watcher log endpoints under
  `webui`.
- Watcher library README/CHANGELOG: new tables, `polllog` package, pruning.

## Out of scope

- Full response bodies / verbose capture mode.
- Showing `watcher_error` events in timelines.
- A per-resource error mark in the Activity header (stays poller-wide).
- Logging interactive (non-poller) Slack, GitHub, or Jira traffic.
- Any agent-handler UI for the new data.

## Rollout

1. Library: implement + tests, tag `v0.13.0`, push `main` and the tag.
2. worktree: `go get github.com/mturley/watcher@v0.13.0 && go mod tidy`;
   implement Parts 2 and 3; `make test`; `make build`.
3. agent-handler picks up the migration and logging on its next re-pin; no code
   change required there.
