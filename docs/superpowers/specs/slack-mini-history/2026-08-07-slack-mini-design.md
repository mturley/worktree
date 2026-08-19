# slack-mini — Design

**Date:** 2026-08-07
**Status:** Approved (brainstorming complete)

## Purpose

A lightweight, tabbed, single-thread Slack viewer. Open a web page, paste a link to a
Slack thread, and get a focused view of just that thread. Open more threads as tabs,
switch between them, rename each tab, and give each a description. The intended use is a
dedicated browser window (or tabs in a cmux workspace) holding the threads relevant to a
single topic — so topic-specific threads don't get lost in the full Slack client.

Distributed as a single Go binary that serves a React frontend and proxies the Slack Web
API using the user's session token.

## Why not reuse the real Slack web UI

- **iframe embedding is blocked.** `app.slack.com` sends `X-Frame-Options` / CSP
  `frame-ancestors`, so it cannot be embedded in our own page.
- **Extensions can't run in cmux's webkit browser**, ruling out a content-script approach
  there.
- Reusing the full client and CSS-hiding everything but the thread pane is fragile and
  heavy (full boot + sockets per tab).

Therefore we render threads ourselves from the Slack Web API. Reverse-engineering
(2026-08-07, verified against the Red Hat workspace) confirmed this is viable — see
Appendix A.

## Architecture

```
Browser tab (cmux) — React app (Vite build, embedded in Go binary via embed.FS)
  • Tab bar: open / rename / describe / switch thread tabs (sessionStorage)
  • Thread view: renders messages (core fidelity) from Slack `blocks`
  • Actions per tab: Mark thread read, Open in Slack, Refresh
  • SSE client for live updates
        │  SSE (updates)              │  HTTP (fetch / actions)
        ▼                             ▼
Go local server (localhost:8473, configurable)
  • Static file server (embed.FS)
  • REST + SSE API
  • package config    — ~/.config/slack-mini/slack-mini.yaml
  • package slackapi  — Slack Web API client behind an interface
  • package watcher   — per-thread poll loops, emits ThreadUpdate (LIFTABLE)
  • package server    — HTTP/SSE + image proxy
  • package cli       — `slack-mini setup`, `slack-mini serve`
        │  HTTPS (xoxc token + `d` cookie)
        ▼
   Slack Web API
```

### Package boundaries

- **`config`** — read/write the YAML config (token, cookie, workspace domain, port).
- **`slackapi`** — thin client over the Slack Web API behind a Go interface:
  `conversations.replies`, `users.info` (batched + cached), `emoji.list` (cached once),
  `subscriptions.thread.mark`, later `chat.postMessage`. Returns **domain structs**
  (`Message`, `User`, `Thread`) — never raw Slack JSON. All Slack payload quirks are
  contained here.
- **`watcher`** — owns polling loops per subscribed thread; emits `ThreadUpdate` events on
  a channel when a thread changes (dedup by `ts`). Depends only on the `slackapi`
  interface and a clock. **No HTTP / SSE / config imports** so it can later be lifted into
  the separate Go library for watching Jira and GitHub.
- **`server`** — static embed.FS, REST endpoints, SSE fan-out, image proxy.
- **`cli`** — `setup` (token acquisition) and `serve`.

## Data flow

**Opening a thread.** User pastes a Slack thread URL into a new tab. Frontend parses it
(`/archives/{channel}/p{ts}` → `channel` + `thread_ts`, plus `?thread_ts=` handling; insert
a dot before the last 6 digits of the `p`-timestamp) and calls `GET /api/thread`. Go fetches
`conversations.replies`, resolves author `users.info` (cached), resolves custom emoji
(`emoji.list`, cached), and returns a normalized `Thread`: ordered messages with author
name/avatar, render-ready content, timestamp, reactions, and `last_read` for the unread
divider.

**Live updates.** While a tab is open, the frontend subscribes via `GET /api/events` (SSE).
The `watcher` polls each subscribed thread every ~5–10s via `conversations.replies` and
emits a `ThreadUpdate` only when messages changed (dedup by `ts`). The SSE layer fans events
to connected browsers. Closing a tab unsubscribes; when no tab watches a thread, its poll
loop stops. **No automatic mark-as-read ever happens** — viewing a thread does not mark it
read.

**Unread divider.** The parent message carries `last_read` (ts of the last message the
current user read on this thread). The divider is rendered before the first reply whose
`ts > last_read`. No separate endpoint needed.

**Mark thread read.** A per-tab button posts `subscriptions.thread.mark`
(`channel`, `thread_ts`, `ts=latest_reply`, `read=1`). This is the only write in v1. Because
we are our own client, we simply never call it unless the user clicks — there is no
auto-mark behavior to suppress.

**Open in Slack.** Builds the canonical
`https://<workspace>.slack.com/archives/{channel}/p{ts}?thread_ts=…&cid=…` deep link
(workspace domain from config) and opens it in a new tab.

## Frontend (React + Vite + Mantine, dark mode)

- **Component library:** Mantine, dark mode as the default theme.
- **Tab bar** (Mantine `Tabs`): one tab per open thread. "+" opens a modal to paste a
  thread URL. Tabs are renamable (double-click → inline edit) with an optional description
  (shown as tooltip/subtitle). Tab metadata `{id, channel, threadTs, name, description}`
  and the open-tab list are persisted in `sessionStorage`. No server-side tab storage.
- **Thread view** (active tab): header shows the thread root author/title plus actions —
  **Mark thread read**, **Open in Slack**, **Refresh**. Body renders messages from Slack
  `blocks` (rich_text renderer): avatar, display name, timestamp, content with resolved
  `<@user>` mentions and `<url|label>` links, custom + unicode emoji, and reactions. An
  **unread divider** is rendered before the first message with `ts > last_read`.
- **Live updates:** one SSE connection feeds active + background tabs; new messages append;
  a subtle "new messages" affordance appears if the user is scrolled up.
- **States:** loading skeleton; error (bad URL, or auth expired → prompt to re-run
  `slack-mini setup`); empty.

## Backend (Go)

- **Endpoints:**
  - `GET /api/thread?channel=…&thread_ts=…` — normalized thread JSON
  - `GET /api/events` — SSE stream of `ThreadUpdate`s; client registers threads to watch
  - `POST /api/thread/mark-read` — `{channel, thread_ts, ts}`
  - `GET /api/avatar?…` and `GET /api/emoji?…` — image proxy (keeps image auth/consistency
    server-side)
  - `POST /api/thread/reply` — v2
- **`slack-mini setup`:** try auto-extraction first (reuse the approach in
  `~/git/slack-mcp/scripts/setup-slack-mcp.py`; if an existing
  `~/.local/share/slack-mcp/tokens.env` is present, offer to import it), then fall back to a
  manual paste prompt (with instructions), then write
  `~/.config/slack-mini/slack-mini.yaml`.
- **`slack-mini serve`:** load config, start the HTTP/SSE server, open the browser.
- **`slack-mini open [threadURL...]`:** does NOT start a server. Probes for a running
  server (prod port `8473` first, then dev port `5174`) via a health check; if found, runs
  the OS `open` command pointed at that base URL. Optional thread URL arguments are appended
  as repeated `?open=<url>` query params; the frontend reads them on load and opens each as
  a tab (deduped against already-open tabs). If no server is running, print a clear message
  telling the user to run `slack-mini serve` (or `make dev`) first. This command is designed
  for later integration with worktree-init tooling that opens resources automatically.

### Ports

Chosen to avoid collisions with the user's other projects (8420 and 5173 are reserved
elsewhere):

- **Go server (dev + prod): `8473`.** Serves the API, SSE, image proxy, and — in prod — the
  built frontend. Configurable via `port:` in `slack-mini.yaml`. On startup, if the port is
  already in use, fail with a clear error naming the port and the config key to change.
- **Vite dev server (dev only): `5174`.** Serves the frontend during development and
  proxies `/api` and `/api/events` to the Go server on `8473`.

## Build & dev tooling

Mirrors the conventions in `mturley/agent-handler`'s `Makefile`.

- **Layout:** Go module at the repo root; frontend in `ui/` (Vite + React + Mantine); the
  built frontend (`ui/dist/`) is embedded into the Go binary via `embed.FS` for prod.
- **`make build`** — `build-web` (`cd ui && npm install && npm run build`) then `build-cli`
  (`go build -o bin/slack-mini .`).
- **`make dev`** — runs both servers in dev mode via **`mprocs`** with named panes
  (`API: localhost:8473`, `Frontend: localhost:5174`). The Go API server auto-reloads via
  **`air`**. If `air` is not on PATH, fall back to a plain `go build` + run and print an
  install hint (`go install github.com/air-verse/air@latest`) plus a GOPATH/bin PATH hint —
  same graceful degradation as agent-handler. `mprocs` is required; error with an install
  hint (`brew install mprocs`) if missing. On exit, kill any lingering process on `8473`.
  In dev the Go server runs API-only and Vite proxies `/api` (incl. `/api/events` SSE) to
  it.
- **`make test`** — `go test ./...`.
- **`make clean`** — remove `bin/`, `ui/dist`, `ui/node_modules`.
- **`make install`** — install the binary to `/usr/local/bin` and run `slack-mini setup`
  (interactive; `--yes` when `NONINTERACTIVE` is set), matching agent-handler's flow.

## Error handling

- Token expiry (`invalid_auth` / `token_expired`) surfaces as a clear "re-run
  `slack-mini setup`" state in the UI.
- `slackapi` handles `ratelimited` with `Retry-After` backoff and retries transient network
  errors.
- Messages without `blocks` (some Slackbot/bot subtypes) fall back to rendering `text`.
  Malformed blocks degrade gracefully to `text`.

## Testing

- `slackapi` normalization: table-driven unit tests over captured real payloads (e.g. the
  `conversations.replies` sample fetched during design).
- `watcher` diff logic: unit-tested with a fake `slackapi` implementation (new message,
  edited message, no change, reaction change).
- Block renderer: tested against captured real payloads.
- Manual smoke test for the UI (tabs, open thread, mark read, open in Slack, live update).

## Phasing

- **v1** — setup CLI + token; read-only thread view (core fidelity: blocks, mentions,
  links, emoji, avatars, reactions, unread divider); tabs with rename/describe in
  sessionStorage; polling + SSE live updates; **Mark thread read**; **Open in Slack**;
  `slack-mini open [threadURL...]` command.
- **v2** — reply sending (`chat.postMessage`, reply input UX).
- **v3** — full fidelity: Block Kit widgets, link unfurls/embeds, file/image attachments,
  richer reaction interactions. Includes a **settings menu** with a toggle between **core
  fidelity** and **full fidelity** rendering, so the user can fall back to the stable core
  renderer if full-fidelity rendering proves fragile for a given thread.

## Non-goals (v1)

- No database; tab metadata lives in `sessionStorage`.
- No multi-workspace support (single configured workspace).
- No Block Kit widget rendering, unfurls, or file attachments (v3).
- No reply sending (v2).

## Appendix A — Reverse-engineering findings (verified 2026-08-07, Red Hat workspace)

**Auth (session mirroring):** `POST https://slack.com/api/{method}` with
`Authorization: Bearer <xoxc-…>` and `Cookie: d=<xoxd-…>`. Form-encoded body for
`conversations.replies`, `users.info`, `emoji.list`. The RH
`slack-mcp` stores these in `~/.local/share/slack-mcp/tokens.env`
(`SLACK_MCP_XOXC_TOKEN` / `SLACK_MCP_XOXD_TOKEN`); extraction is handled by
`~/git/slack-mcp/scripts/setup-slack-mcp.py`. Error codes: `not_authed`, `invalid_auth`,
`token_expired`, `ratelimited` (respect `Retry-After`).

**`conversations.replies`** (params `channel`, `ts`, `limit`; paginate via
`response_metadata.next_cursor` + `has_more`). Returns `messages[]`. The **parent message**
carries `last_read`, `subscribed`, `reply_count`, `latest_reply`, `reply_users[]`. Each
message has `ts`, `user`, `text`, `blocks`, and optional `reactions` / `edited`.

**Rendering:** prefer `blocks` (typed `rich_text` → `rich_text_section` with elements
`{type: user|text|emoji|link|…}`; standard emoji include a `unicode` codepoint, custom emoji
don't) over parsing `text`. `text` mrkdwn tokens: `<@UID>`, `<!subteam^SID>`, `<url|label>`,
`:emoji_name:`. `reactions: [{name, users[], count}]`.

**`users.info`** → `real_name`, `profile.display_name`, avatars
`profile.image_{24,32,48,72,192,512,1024}` on `avatars.slack-edge.com`.

**`emoji.list`** → name→URL map on `emoji.slack-edge.com` (~22.7k in the RH workspace);
some values are `alias:other-name` (deref once). Fetch once, cache.

**`subscriptions.thread.mark`** (from the sensible-slack-extension reverse-engineering):
`POST /api/subscriptions.thread.mark` with `channel`, `thread_ts`, `ts`, `read=1` →
`{"ok":true}`. Used for the Mark-thread-read button.

**Related prior work:**
`~/git/sensible-slack-extension/docs/reverse-engineering/navigation.md` (deep-link/SPA nav)
and `.../thread-read-control.md` (read-state control).
