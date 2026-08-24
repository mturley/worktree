# worktree

Go CLI for managing git worktrees. See `docs/design-proposal.md` for architecture.

## Build & Test

```bash
make build     # builds the ui/ frontend then the Go binary (bin/worktree, embeds ui/dist)
make build-web # builds only the ui/ frontend into ui/dist
make test      # runs go test ./...
make install   # installs to /usr/local/bin + runs setup
make dev       # runs the Go API + Vite dev server concurrently (needs mprocs, else prints manual instructions)
make clean     # removes bin/, ui/dist contents (keeps ui/dist/.gitkeep), ui/node_modules
```

`worktree ui` starts the web UI: a Mantine + React frontend (`ui/`) served by the Go binary with the built assets embedded. Default port 8475 in production; the Vite dev server (via `make dev`) runs on 5175 and proxies to the Go API server (`--api-only`).

## Project Structure

- `cmd/` — cobra commands (one file per subcommand)
- `internal/` — packages:
  - `config` — YAML config + env var overrides
  - `db` — SQLite DB lifecycle + schema migrations (Phase 1)
  - `registry` — worktree registry (CRUD ops on `worktrees` table)
  - `discovery` — only `IsInsideWorktree` now; worktree discovery moved to DB via `registry.List`
  - `gitutil` — git operations
  - `github` — GitHub PR metadata via `gh` CLI
  - `jira` — Jira REST API client
  - `ports` — port range allocation (DB-backed; `port_allocations` table)
  - `resources` — worktree resource tracking (DB-backed; `watcher_subscriptions` + `worktree_primary` table). A resource's user-supplied **custom name/description** live in `watcher_resource_meta` (with an `updated_at` as of watcher v0.4.4); set them via the web UI or `worktree resources set-name <type> <id> --name … [--updated-at …]`. `resources list --json` exposes `custom_name`/`custom_description`/`updated_at`; agent-handler mirrors Slack-thread custom names into its own DB (newest-wins) via this CLI — see agent-handler's Phase 7. `SetMetaAt` preserves an explicit timestamp for that cross-DB replication; plain `SetMeta` stamps now.
  - `shellenv` — shell environment variable generation from DB (worktree env)
  - `env` — deprecated; superseded by `shellenv`
  - `dotfiles` — gitignored dotfile copying
  - `setup` — shell RC integration (removed `.git/info/exclude` management); also owns the `worktree setup` Slack step (`setup/slack.go`) that walks the user through extracting Slack session token+cookie and writes them to `~/.config/watcher/auth.yaml`
  - `ui` — terminal output
  - `webui` — HTTP server + API for `worktree ui` (worktree list, timeline, resources, SSE stream, poll loop); also serves the Slack tab's routes (`/api/thread*`, `/api/slack-*`) from the same binary/port
  - `slackpoller` — polls Slack threads for changes and fans out updates to subscribers (live-tab SSE, in-memory, only while a thread is open in the UI); folded in from slack-mini's `internal/watcher` package (renamed to avoid collision); consumes `github.com/mturley/watcher/slack`'s `Client`/`Thread` types rather than a local `slackapi` package — there is no `internal/slackapi` anymore, it moved to the watcher library (see "Watcher library" below)
  - `slackcreds` — loads Slack token/cookie/workspace domain from the shared watcher `auth.yaml` and builds a `github.com/mturley/watcher/slack.Client`
  - `slackurl` — parses Slack thread URLs into `(channel, threadTS)` and builds the resource ID used to store them as worktree resources

There are two distinct pollers in play, don't conflate them: (1) the watcher
library's github/jira/**slack** pollers (`watcher/github`, `watcher/jira`,
`watcher/slack`), all called from `internal/webui/poller.go`'s `pollAll` on the
regular DB-backed poll loop, writing `watcher_events`/`watcher_resource_state`
for every subscribed resource — PRs, Jira issues, and (as of Phase 4) Slack
threads alike; (2) worktree's own live-tab `internal/slackpoller`, an
in-memory SSE poller that only runs while a Slack thread is open in the UI,
for near-real-time updates to that one thread. Slack used to only have (2);
now it has both.

Slack threads are worktree resources (`worktree add <slack-thread-url>`), shown in a per-worktree resource-scoped "Slack" tab in the web UI (alongside "Overview") — see `docs/web-ui-architecture.md` "Slack tab" section for the full map (routes, DTOs, frontend structure). Slack credentials live in the shared watcher config at `~/.config/watcher/auth.yaml` (not a worktree-specific file), acquired via the `worktree setup` Slack step.
- `ui/` — Mantine + React frontend for `worktree ui` (Vite build; output embedded into the Go binary via `ui/dist`)
- `docs/` — design documents and feature catalog; see `docs/web-ui-architecture.md` for the web UI (backend routes, DTOs, frontend structure, gotchas)

## Watcher library

worktree is a **consumer** of `github.com/mturley/watcher` (GitHub
`mturley/watcher`, maintained locally at `~/git/watcher`). worktree does not
implement its own polling engine, event schema, or DB layer for external
resources — it pins a released version of the library (see `go.mod`) and
calls into it for:

> **IMPORTANT — separate DB, shared SCHEMA only.** worktree has its OWN watcher
> database (`${XDG_DATA_HOME:-~/.local/share}/worktree/worktree.db`). agent-handler,
> the library's other consumer, has a DIFFERENT database file
> (`~/.agent-handler/data/handler.db`). They share only the library's *schema* and
> code — never rows. worktree's subscriptions (subscriber `worktree:<path>`) and
> handler's (subscriber `handler:<session>`) live in physically separate SQLite
> files; there is no shared table, no cross-tool row, no joint query. Do not reason
> about "the other tool's subscriptions" as if they were in this DB — they are not.
> The only worktree↔handler interop is at the CLI level (handler shells out to the
> `worktree` binary; see agent-handler's Phase 5). If you ever think a change here
> could affect handler's data directly, stop — it can't; the coupling is CLI + schema,
> not database.



- the resources DB (`watcher_subscriptions`, via `internal/resources`)
- the PR/Jira/**Slack** pollers (the in-process poll loop in
  `internal/webui/poller.go` — `worktree ui` has no external scheduler; see
  `docs/web-ui-architecture.md` "Polling model")
- timeline events (`watcher_events`, `watcher_event_resources`)
- cached resource state (`watcher_resource_state`) shown in the web UI's
  resource cards
- the Slack Web API client + domain types (`github.com/mturley/watcher/slack`)
  — as of Phase 4 there is no local `internal/slackapi` package; worktree's
  own `internal/slackcreds` and `internal/slackpoller` consume the library's
  `slack.Client`/`slack.Thread` directly

### IMPORTANT: cross-repo coordination

Any worktree change that needs new/changed poller behavior, schema, event
types, cached-state fields, or DB APIs is **cross-repo work**:

1. Make the change in `~/git/watcher`, with tests (`go test ./...` there).
2. Commit, then cut a new library release tag (e.g. `vX.Y.Z`) and **push
   both**: `git push origin main` and `git push origin vX.Y.Z`.
3. In this repo, re-pin: `go get github.com/mturley/watcher@vX.Y.Z && go mod
   tidy`, then rebuild/re-test.
4. Rebuild worktree (`make build`).

Do NOT work around a library limitation with a local patch here — fix it in
the library and re-pin. The library is also consumed by `agent-handler`, so
behavior must stay correct for multiple consumers.

Worked example: Phase 2 needed PR author in the web UI's resource cards. PR
author (shown) and Jira reporter (cached for future use, not yet displayed)
were both added to `buildPRStateJSON`/`buildJiraStateJSON` in `~/git/watcher`,
released as `v0.2.5`, and re-pinned here (`go.mod` now pins
`github.com/mturley/watcher v0.2.5`).

Poller/source bugs (missing event types, dedup false-positives, GraphQL/REST
query gaps, missing cached fields) are **library bugs** — diagnose and fix
them in `~/git/watcher/github/` or `~/git/watcher/jira/`, not here.

**Gotcha:** `watcher_subscriptions` rows are keyed by the canonical
`wdb.Subscriber(path)` (`internal/db`), never a raw `"worktree:" + path`
concat — see `docs/web-ui-architecture.md` for the full explanation (it bit
the Phase 2 build repeatedly, especially on macOS/symlinked paths). Any new
code joining worktrees to their subscriptions must canonicalize through
`wdb.Subscriber`.

## Reverse-engineering documentation — READ AND MAINTAIN

`docs/reverse-engineering/slack-web-api.md` documents how Slack's (largely
undocumented) Web API behaves — auth, endpoints, payload shapes, quirks — as
verified by direct experimentation. BEFORE working on anything touching the
Slack API (`github.com/mturley/watcher/slack`, the slackpoller, message
rendering, auth), read that file first. AFTER you learn anything new about how Slack works (a new
field, changed response shape, new endpoint, auth quirk, rate-limit behavior,
block type), update that doc in the same change and add a regression fixture
rather than silently working around it. Treat the doc as part of the deliverable.

## Slack conventions (folded in from slack-mini)

- **`github.com/mturley/watcher/slack` (in the watcher library, not this repo)
  contains all Slack payload quirks.** It returns domain structs (Message,
  User, Thread, Reaction, File, Attachment, Block/Element, BlockKit), never
  raw Slack JSON. The rest of the codebase never touches raw Slack JSON.
  `normalize.go`'s `normalizeMessage` is the single per-message mapper — new
  message fields go there so thread fetches and posted replies both get them.
  Any change here is cross-repo work (see "Watcher library" above): fix it in
  `~/git/watcher/slack/`, re-release, re-pin.
- **Rendering pipeline — do NOT reinvent.** Render a message's typed `blocks`
  via `RichText.tsx` (rich_text) — the primary path; never reparse `text`. When
  only an mrkdwn *string* is available (block-less `text` fallback, attachment
  text, Block Kit section/context text), use the SHARED `ui/src/lib/mrkdwn.tsx`
  (`<Mrkdwn>`) — never write a second mrkdwn parser. Block Kit inside attachments
  renders via `BlockKit.tsx` (delegates rich_text back to RichText). Emoji
  resolution is shared via `lib/emoji.ts` + `lib/renderEmoji.tsx`.
- **Never auto-mark threads read.** Only the explicit "Mark thread read" action
  calls `subscriptions.thread.mark` — viewing a thread must not mark it read.
- **Writes are optimistic + rolled back on failure** via `useThread.applyLocal`
  + `refresh()` (replies, mark-unread, reaction toggles). There is no send
  allowlist (dropped in the fold-in) — writes are unrestricted.
- **Slack test fixtures (`~/git/watcher/slack/testdata/`, formerly
  `internal/slackapi/testdata/`) MUST be synthetic/sanitized** — real JSON
  structure, but NO real Slack content (names, message text, links) and NO
  secrets. Never commit captured real payloads.
- **Slack creds are the user's own session credentials** (xoxc- token + xoxd-
  cookie), stored in `~/.config/watcher/auth.yaml` (0600). Treat like a password;
  never commit. Tokens expire every 1-2 weeks → re-run `worktree setup`.
- **ThreadResponse wire quirk:** top-level keys are camelCase, but the embedded
  `slack.Message` (from `github.com/mturley/watcher/slack`) + nested structs
  serialize PascalCase (Go defaults). The
  TS types in `ui/src/api/slackApi.ts` mirror this (e.g. `message.TS`,
  `reaction.UserIDs`); nil slices/pointers marshal to `null` → TS guards them.
