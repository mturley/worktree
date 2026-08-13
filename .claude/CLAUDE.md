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
- `docs/` — design documents and feature catalog
