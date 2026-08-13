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
  - `resources` — worktree resource tracking (DB-backed; `watcher_subscriptions` + `worktree_primary` table)
  - `shellenv` — shell environment variable generation from DB (worktree env)
  - `env` — deprecated; superseded by `shellenv`
  - `dotfiles` — gitignored dotfile copying
  - `setup` — shell RC integration (removed `.git/info/exclude` management)
  - `ui` — terminal output
  - `webui` — HTTP server + API for `worktree ui` (worktree list, timeline, resources, SSE stream, poll loop)
- `ui/` — Mantine + React frontend for `worktree ui` (Vite build; output embedded into the Go binary via `ui/dist`)
- `docs/` — design documents and feature catalog; see `docs/web-ui-architecture.md` for the web UI (backend routes, DTOs, frontend structure, gotchas)

## Watcher library

worktree is a **consumer** of `github.com/mturley/watcher` (GitHub
`mturley/watcher`, maintained locally at `~/git/watcher`). worktree does not
implement its own polling engine, event schema, or DB layer for external
resources — it pins a released version of the library (see `go.mod`) and
calls into it for:

- the resources DB (`watcher_subscriptions`, via `internal/resources`)
- the PR/Jira pollers (the in-process poll loop in `internal/webui/poller.go`
  — `worktree ui` has no external scheduler; see `docs/web-ui-architecture.md`
  "Polling model")
- timeline events (`watcher_events`, `watcher_event_resources`)
- cached resource state (`watcher_resource_state`) shown in the web UI's
  resource cards

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

Worked example: Phase 2 needed PR author + Jira reporter shown in the web
UI's resource cards. Both fields were added to `buildPRStateJSON`/
`buildJiraStateJSON` in `~/git/watcher`, released as `v0.2.5`, and re-pinned
here (`go.mod` now pins `github.com/mturley/watcher v0.2.5`).

Poller/source bugs (missing event types, dedup false-positives, GraphQL/REST
query gaps, missing cached fields) are **library bugs** — diagnose and fix
them in `~/git/watcher/github/` or `~/git/watcher/jira/`, not here.

**Gotcha:** `watcher_subscriptions` rows are keyed by the canonical
`wdb.Subscriber(path)` (`internal/db`), never a raw `"worktree:" + path`
concat — see `docs/web-ui-architecture.md` for the full explanation (it bit
the Phase 2 build repeatedly, especially on macOS/symlinked paths). Any new
code joining worktrees to their subscriptions must canonicalize through
`wdb.Subscriber`.
