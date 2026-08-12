# worktree

Go CLI for managing git worktrees. See `docs/design-proposal.md` for architecture.

## Build & Test

```bash
make build    # builds to bin/worktree
make test     # runs go test ./...
make install  # installs to /usr/local/bin + runs setup
make clean    # removes bin/
```

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
- `docs/` — design documents and feature catalog
