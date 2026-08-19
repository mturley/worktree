# Phase 4 — Slack timeline poller (watcher `slack` resource type) — Design

**Status:** Approved in-session 2026-08-19. Ready for implementation planning.

**Parent roadmap:** `docs/superpowers/specs/2026-08-11-worktree-ui-and-watcher-adoption-roadmap.md` (Phase 4 + CC-3). This design resolves the CC-3 open decisions ("decide at P4").

## Goal

Add a `slack` resource type + Slack thread poller to the `github.com/mturley/watcher` library so new Slack thread replies appear as events in worktree's timeline views, and cache each thread's title so the Overview resource card shows something human instead of the raw `channel:ts` id. Released as watcher **v0.3.0**, consumed by worktree.

## Architecture

A new **`watcher/slack` package** in the library, mirroring the existing `github/` and `jira/` poller packages. It owns the Slack fetch layer (the API client + domain types, lifted from worktree's dependency-free `internal/slackapi`) and a new timeline `Poll`. The library becomes the single canonical home for Slack domain types and polling, so **agent-handler can later consume Slack identically to github/jira with no second lift** (a stated design goal).

### Cross-repo split

**Moves into `watcher/slack` (what any consumer needs):**
- The API client: `Client` interface + `HTTPClient`, `New(token, cookie)`, `NewWithBaseURL(token, cookie, baseURL)`.
- Domain types: `Thread`, `Message`, `User`, `Reaction`, `File`, `Attachment`, `Block`/`Element`/`BlockKit`/`TextObject`/`Style`, and `ErrAuth`, `UnreadDividerIndex`, `NormalizeThread`/`normalizeMessage`.
- The new timeline `Poll` + its `SlackAuth` creds struct.

**Stays in worktree (UI-only glue), re-importing the domain types from `watcher/slack`:**
- `internal/webui/slack.go`, `slack_proxy.go`, `slack_sse.go` (SSE, image proxies, `MessageView`, reply/react/mark-read handlers).
- `internal/slackpoller` (the in-memory live-tab SSE poller).
- `internal/slackcreds` (creds loader → builds a client), `internal/slackurl` (URL parsing / resource ID).
- `internal/setup/slack.go` (`TeamInfo`-based setup validation).

### Three distinct pollers (unchanged relationship)
1. **Live-tab `slackpoller`** (worktree, in-memory, SSE fan-out for the open thread view) — stays as-is; serves real-time tab freshness (~8s), no DB.
2. **New library timeline poller** (`watcher/slack.Poll`) — durable, writes `watcher_events`, runs in worktree's `pollAll` (2min).
3. **pr/jira poll loop** — unchanged.
They may share the same fetch client but write to different sinks; do not conflate.

## The library poller (`watcher/slack/poller.go`)

Mirrors `jira/` (the multi-cred precedent — `JiraAuth`).

```go
// SlackAuth carries the browser-session creds the Slack poller needs.
// Sourced from (*config.Config).Slack() which already returns these three.
type SlackAuth struct {
    Token           string // xoxc- token
    Cookie          string // xoxd- d= cookie value
    WorkspaceDomain string // for permalinks (may be empty)
}

// Poll fetches each watched Slack thread's replies and emits one slack_reply
// event per new reply after the cursor, caches the thread title in
// resource_state, and records poller success. Mirrors github.Poll / jira.Poll.
func Poll(conn *sql.DB, cfg SlackAuth, resources []watcher.Resource, logger *log.Logger) error
```

### Per-resource algorithm (internal `processThread`, mirrors `jira.processIssue`)
Resource `ID` = `"<channel>:<thread_ts>"` (existing convention, `internal/slackurl.ResourceID`).

1. Parse `channel:threadTS` from `resource.ID`. On parse failure: log + continue (don't abort the batch).
2. Fetch the thread: `client.Replies(ctx, channel, threadTS)` → `Thread` (root = `Messages[0]`; replies = `Messages[1:]`).
3. **Always** cache state (§ Cached state) — including first poll.
4. `cursor, _ := db.EventCursor(conn, "slack", resource.Type, resource.ID)` (`MAX(external_ts)` for this source+resource; `""` if none).
5. **First-poll gate** (identical to `github.go:152` / `jira.go:154`):
   `if cursor == "" && !db.BackfillFor(conn, resource.Type, resource.ID)` → emit `watch_started` only, return. (No history flood. Backfill, if set, falls through and replays all replies.)
6. Else, for each reply `m` in `Messages[1:]` with `m.TS > cursor` (string compare — safe because Slack `ts` are fixed-width, zero-padded, monotonic epoch-second strings): emit one `slack_reply` event.
7. On any fetch/parse error for a resource: `emitError` (guarded by `db.HasPollerError(conn, "slack")`), continue.
8. After the loop: `db.RecordPollerSuccess(conn, "slack")`.

### Load-bearing invariant (CC-3)
**Every Slack event's `ExternalTS` is the raw Slack `ts` string — never converted to RFC3339.** `db.EventCursor` uses `MAX(external_ts)` and the pollers use string `<=`/`>` comparison; RFC3339 works for github/jira because it's lexicographically ordered, and Slack `ts` works because it's fixed-width monotonic. The two must never mix — they don't, because `EventCursor` filters by `source` and Slack's source is `"slack"`. Converting a Slack ts to RFC3339 would break both ordering and the cursor. This invariant must be stated in the poller code and covered by a test.

### Event shape — `slack_reply`
- `Source: "slack"`, `Type: EventTypeSlackReply`.
- `ExternalTS`: the reply's raw `ts`.
- `Title`: `"New reply in <thread title>"` where thread title = cached/derived first-message snippet, or `"#<channel name>"` / the channel id if unavailable.
- `Body`: `"<author display name>: <reply text snippet>"` (text truncated ~140 chars; author resolved via `client.Users(ctx, [userID])`).
- `Author`: resolved display name (nil if unresolvable).
- **Dedup:** `db.IsDuplicate` with `ExternalTS`-only mode (`DedupCheck{Source:"slack", ResourceType, ResourceID, Type, ExternalTS:&ts}`). A Slack `ts` is unique per message, so ExternalTS alone is sufficient (no Title/Both mode).

### New event type (`watcher/eventtype.go`)
- Add const `EventTypeSlackReply EventType = "slack_reply"` to the const block.
- Add `EventTypeSlackReply: "Slack replies"` to `eventTypeDisplayNames`.
- (Reserve `slack_reaction` conceptually for a later phase; do NOT add it now — replies-only this phase.)

## Cached state (Overview card fallback — closes the Phase-3b deferral)

Internal `buildSlackStateJSON` → `db.UpsertResourceState(conn, "slack", resource.ID, stateJSON, latestTS, now)`, written on **every** poll (including first):

```json
{
  "title": "<first-message text, whitespace-collapsed, truncated to 60 chars + …>",
  "channel_name": "<resolved #channel name, if available>",
  "reply_count": <number of replies>
}
```
- `resource_updated_at` = the latest reply `ts` (or root `ts` if no replies).
- Port `ui/src/lib/fallbackTitle.ts`'s truncation (collapse whitespace, trim, 60-char cap + `…`) to a small Go helper in `watcher/slack` so cached and live-view titles match.

### Worktree consumption
- `internal/webui/resources_api.go` `enrichResourceDTO`: add `case "slack": if v, ok := m["title"].(string); ok { dto.Title = v }` (mirrors the pr/jira cases). This sets `dto.Title` from cached state.
- `ui/src/components/ResourceCard.tsx` `SlackCardBody`: fallback becomes **`custom_name || title || id`** — user's custom name still wins; the cached title replaces the raw `channel:ts` shipped in Phase 3b; raw id remains the last resort (thread never polled yet).

## Timeline rendering

No worktree switch needed: `internal/webui/timeline.go` derives `type_label` via `watcher.EventType(...).DisplayName()`. The new `EventTypeSlackReply` display-name mapping makes `slack_reply` render as "Slack replies" automatically.

**Dedup caveat (heeded, no change needed):** the post-LIMIT single-resource-per-event dedup warning at `timeline.go:139-142` was about Slack events potentially linking multiple resources. This design links exactly one resource (the thread) per `slack_reply` event — same as pr/jira — so the concern does not apply.

## `pollAll` wiring (worktree `internal/webui/poller.go`)

Add a third branch mirroring pr/jira (answers the parked "should worktree poll Slack at all" question: **yes**, via the same in-process loop — consistent, no new scheduler, CC-1 double-poll cost stays negligible; handler doesn't poll Slack yet):

```go
if threads, _ := watcherdb.ActiveResources(s.DB, "slack"); len(threads) > 0 {
    if sc, err := cfg.Slack(); err == nil {
        auth := wslack.SlackAuth{Token: sc.Token, Cookie: sc.Cookie, WorkspaceDomain: sc.WorkspaceDomain}
        if err := wslack.Poll(s.DB, auth, threads, s.logger()); err != nil {
            s.logger().Printf("slack poll: %v", err)
        }
    } else {
        s.logger().Printf("slack not configured; skipping %d slack resources", len(threads))
    }
}
```

## Error handling
- Missing Slack creds (`cfg.Slack()` error) → skip + log, not fatal (matches github/jira).
- A single thread's fetch/parse error → `emitError` + continue; never abort the whole batch.
- Auth failure (`ErrAuth`) surfaces via `emitError`/poller-status; the tab already tells the user to re-run `worktree setup` when creds expire.

## Testing
- **Library (`watcher/slack/poller_test.go`):** first-poll → only `watch_started`; second poll with new replies → one `slack_reply` each with raw-ts `ExternalTS`; cursor advance (no re-emit of already-seen replies); dedup (same ts not re-emitted); backfill flag replays; `buildSlackStateJSON` caches title/channel/reply_count; the raw-ts-not-RFC3339 invariant (a test asserting the stored `external_ts` equals the Slack `ts` verbatim and ordering holds).
- **Lifted `slackapi` tests** travel with the package into `watcher/slack`.
- **worktree:** `enrichResourceDTO` slack case (cached title → `dto.Title`); `SlackCardBody` fallback precedence (`custom_name || title || id`); `pollAll` slack branch (enumerates `ActiveResources("slack")`, skips when unconfigured).
- Existing worktree Slack UI tests must still pass after the import-path rewrite to `watcher/slack`.

## Release & migration
- Cut watcher **v0.3.0** (new resource type = feature-level minor). **Verify the committed tree builds+tests green in an isolated detached worktree before tagging** (the v0.2.6 lesson), then `git push origin main && git push origin v0.3.0`.
- Re-pin worktree: `go get github.com/mturley/watcher@v0.3.0 && go mod tidy`, rewrite `internal/slackapi` importers to the library path, rebuild + retest.
- **No data migration:** existing Slack subscriptions simply get `watch_started` + a cached title on the next poll after upgrade.

## Non-goals (this phase)
- Slack reactions as events (replies-only; reserve `slack_reaction` for later).
- Unifying the live-tab poller with the timeline poller (they stay separate).
- agent-handler consuming Slack (Phase 6 — this phase only makes it *possible* by putting the domain + poller in the library).
- Backfilling thread history on first watch (watch_started-only gate, matching github/jira).
