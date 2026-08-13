# Worktree CLI: Design Proposal

A Go-based CLI for managing git worktrees with GitHub/Jira integration and optional cmux support. Replaces the old `worktree-old` bash script with a focused, maintainable tool.

## Design Principles

1. **CLI-first** — Every action is a subcommand with flags. No action requires a REPL.
2. **Standalone by default** — Works in any terminal with no dependencies beyond `git`.
3. **cmux as an upgrade** — When running inside cmux, unlock extra features (workspace management, browser panes).
4. **Persistence via DB** — Worktree state (registry, resources, port allocations) lives in a SQLite database instead of scattered files, enabling atomic operations and cross-tool integration (Phase 1).
5. **Self-contained binary** — Single Go binary with embedded assets. `go install` or `make install` followed by `worktree setup`.

---

## Decisions

### Keep

| Feature | Notes |
|---------|-------|
| **Worktree registry** | DB-backed discovery: `worktree list` reads `worktrees` table; `worktree cleanup` reconciles disk vs DB (orphans, stale) |
| **PR worktree workflow** | Accept PR number or URL, fetch metadata, find/create worktree, register in DB |
| **Branch worktree workflow** | Accept branch name, create from upstream/main or origin/main |
| **Path-based open** | Accept existing worktree path directly |
| **No-args listing** | List worktrees from DB with interactive selection |
| **Cleanup** | Remove worktrees, release ports, prune stale DB entries, reconcile with disk |
| **Port range system** | Unique port range per worktree (DB-backed `port_allocations` table) |
| **Environment variables** | `worktree env` command prints `export ...` lines from DB; shell RC runs `eval "$(worktree env)"` on `cd` |
| **Resource tracking** | PR/Jira associations in DB (`watcher_subscriptions` + `worktree_primary` flag table) |
| **Isolated kubeconfig** | `~/.kube/config-<repo>-<worktree>` |
| **Shell RC integration** | Setup installs `chpwd` hook; cleanup removes it. Hook runs `eval "$(worktree env)"` |
| **GitHub** (via `gh` CLI) | PR metadata, branch detection, open in browser |
| **Jira** (via REST API) | Issue detection from branch/PR, API enrichment, manual association, open in browser |
| **cmux** | Workspace creation with configurable layout, deduplication, browser panes for PR/Jira |
| **Dotfile copying** | On worktree creation, offer to copy gitignored dotfiles from the main clone (replaces the broader file cloning system) |

### Cut

| Feature | Why |
|---------|-----|
| **mprocs integration** | cmux does this better |
| **GNU Screen persistence** | cmux handles persistence natively |
| **iTerm tab titles** | Narrow use case |
| **Nested mprocs sessions** | Gone with mprocs |
| **Multi-arg parallel open** | Unnecessary complexity; single worktree per invocation |
| **Preference caching in /tmp** | Use config file instead |
| **Editor detection/caching** | Use `$EDITOR` or config file |
| **VS Code tasks.json** | Niche |
| **File cloning (node_modules, dist/, bin/)** | Too complex; dotfile copying covers the useful case |
| **python3 dependency** | Go handles JSON natively |
| **osascript notifications** | macOS-only, unnecessary |
| **Powerlevel10k patching** | Fragile and surprising |
| **REPL** | Not in v1. Every action works as a subcommand. May add later if missed. |
| **Claude Code skill** | Overkill for this tool |

---

## CLI Structure

### Primary Commands (Smart Argument Routing)

```
worktree                                    # list/select worktrees (interactive)
worktree <PR-number>                        # create/open PR worktree
worktree <PR-URL>                           # create/open PR worktree (from URL)
worktree <branch-name>                      # create/open branch worktree
worktree <path>                             # open existing worktree
```

"Open" for existing worktrees means: show info and enter the worktree context (cd, set env). For new worktrees: create, register in DB, offer to copy dotfiles, show info.

### Subcommands

```
worktree info [<path>]                      # show worktree info (default: current dir)
worktree info --local                       # skip API calls (fast)
worktree list                               # list worktrees from DB
worktree cleanup                            # reconcile disk vs DB (remove orphans, stale entries)
worktree delete [<path>]                    # remove worktree + cleanup
worktree ports                              # show/manage port allocations (DB-backed)

worktree env                                # print shell env vars (use: eval "$(worktree env)")
worktree resources list [--json]            # list tracked resources (DB-backed)
worktree resources add <type> <id> [--url <url>] [--related]  # add a resource
worktree resources unwatch <type> <id>      # soft-remove (mark inactive)
worktree resources remove <type> <id>       # hard-remove from DB

worktree open [<path>]                      # open in editor ($EDITOR or configured)
worktree open --github                      # open PR in browser
worktree open --jira                        # open Jira issue(s) in browser

worktree jira [<path>]                      # show/manage Jira associations
worktree jira add <key> [--related]         # associate a Jira issue
worktree jira remove <key>                  # remove a Jira association

worktree watcher run [pr|jira|all]          # one-shot poller for timeline events
worktree setup                              # post-install configuration
worktree setup --uninstall                  # reverse setup changes
worktree update                             # self-update + re-run setup
worktree version                            # print version
```

### Implicit Worktree Context

Most subcommands accept an optional `[<path>]` argument. When omitted, they detect the current worktree from the working directory (via `git rev-parse --show-toplevel`). This means you can `cd` into a worktree and just run `worktree info`, `worktree open --jira`, etc.

---

## Configuration

Config file at `~/.config/worktree/config.yaml` (or `$XDG_CONFIG_HOME/worktree/config.yaml`):

```yaml
# Where worktrees are created (default: ~/.worktrees)
worktrees_base: ~/.worktrees

# Jira integration
jira:
  host: your-org.atlassian.net
  email: you@example.com
  token: your-jira-api-token
  projects:
    - RHOAIENG
    - RHOAI
    - ODH

# Editor for `worktree open` (default: $EDITOR)
editor: cursor

# cmux workspace layout (used when creating workspaces inside cmux)
cmux:
  layout:
    # Pane configuration for new workspaces
    # Each pane has a role, position, and optional size
    panes:
      - role: terminal           # worktree shell
        position: left
        size: 50%
      - role: browser            # PR/Jira URLs (only created when URLs are detected)
        position: right
        size: 50%
```

Environment variables still work as overrides:
- `WORKTREES_BASE` overrides `worktrees_base`
- `WORKTREE_DB` overrides the default DB path (`${XDG_DATA_HOME:-~/.local/share}/worktree/worktree.db`)

---

## Persistence (Phase 1: DB adoption)

Worktree state is stored in a SQLite database at `${XDG_DATA_HOME:-~/.local/share}/worktree/worktree.db` (overridable via `WORKTREE_DB`). The database includes:

- **`worktrees` table** — Registry of all worktrees created by this tool (CRUD via `internal/registry`)
- **`port_allocations` table** — Port ranges (atomic allocation via `internal/ports`)
- **`worktree_primary` table** — Primary resource flag for `watcher_subscriptions` rows (e.g., the reason a worktree exists)
- **`watcher_*` tables** — Owned by the `github.com/mturley/watcher` library; includes `watcher_subscriptions` (PR/Jira associations) and `watcher_events` (timeline events from `worktree watcher run`)

**Shell environment variables** are generated on-demand by `worktree env`, which queries the database and prints `export ...` lines. The shell RC hook runs `eval "$(worktree env)"` on directory change (via the `chpwd` hook installed by `worktree setup`).

**Resource tracking** (PR/Jira associations) is stored in `watcher_subscriptions` with a `worktree_primary` flag. The `worktree resources --json` command emits a machine-readable contract for agent-handler integration:

```json
[
  {"type":"pr","id":"owner/repo#123","url":"https://github.com/owner/repo/pull/123","primary":true},
  {"type":"jira","id":"RHOAIENG-456","url":"https://redhat.atlassian.net/browse/RHOAIENG-456","primary":true},
  {"type":"jira","id":"RHOAIENG-400","url":"https://redhat.atlassian.net/browse/RHOAIENG-400","primary":false}
]
```

---

## Install Experience

Following the agent-handler pattern:

1. **Build:** `make build` compiles to `bin/worktree`
2. **Install:** `make install` copies to `/usr/local/bin/worktree` (atomic write) and runs `worktree setup`
3. **Alternative:** `go install github.com/mturley/worktree@latest` then `worktree setup`
4. **Setup** (`worktree setup`):
   - Dry-run preview of all changes, prompt for confirmation
   - Create `worktrees_base` directory if needed
   - Add shell RC hook (`chpwd`) that runs `eval "$(worktree env)"` on directory change (zsh/bash/fish)
   - Create default config file if none exists
   - `--yes` flag for non-interactive use
5. **Uninstall** (`worktree setup --uninstall`):
   - Remove shell RC snippet
   - Remove config file (with confirmation)
   - Preserve worktree data (with instructions for full removal)
6. **Update** (`worktree update`):
   - Detect install method (go install vs manual)
   - Run `go install @latest` or prompt for manual update
   - Re-run `worktree setup`

---

## Project Structure (Go)

```
worktree/
  cmd/                        # cobra commands
    root.go                   # root command, smart argument routing
    info.go
    list.go
    delete.go
    cleanup.go
    ports.go
    open.go
    jira.go
    setup.go
    update.go
    version.go
  internal/
    config/                   # YAML config + env var overrides
    db/                       # SQLite DB lifecycle + migrations (Phase 1)
    registry/                 # worktree registry (CRUD on `worktrees` table)
    discovery/                # only `IsInsideWorktree` now; discovery moved to DB
    git/                      # git operations (worktree create/remove, branch, fetch)
    github/                   # gh CLI wrapper for PR operations
    jira/                     # Jira REST API client
    ports/                    # port range allocation (DB-backed; `port_allocations` table)
    resources/                # resource tracking (DB-backed; `watcher_subscriptions` + `worktree_primary`)
    shellenv/                 # shell environment variable generation from DB (worktree env)
    dotfiles/                 # gitignored dotfile copying
    cmux/                     # cmux workspace integration
    setup/                    # shell RC integration (removed .git/info/exclude management)
    ui/                       # terminal output (colors, spinners, prompts)
  embedded/                   # go:embed files (shell snippets, templates)
  Makefile
  go.mod
  main.go
```

---

## Dependencies

### Required
- `git` — core worktree operations

### Optional
- `gh` — GitHub PR operations (graceful degradation without it)
- Jira credentials — for Jira API enrichment
- cmux — for workspace integration

### Removed (vs old script)
- python3, mprocs, GNU Screen >= 5.0, curl, lsof

---

## Dotfile Copying

When creating a new worktree, the tool offers to copy gitignored dotfiles (top-level hidden files/dirs like `.env.local`, `.husky`, etc.) from the main clone. This replaces the old script's broader file cloning system.

**Behavior:**
1. Discover top-level gitignored dotfiles in the main worktree (excluding `.git`)
2. Show a list and prompt for confirmation (select all, select specific, or skip)
3. Copy using `cp -Rc` on macOS (APFS copy-on-write) or `cp -r` elsewhere
4. No caching of selections — prompt each time (simple and predictable)

Available as part of the create flow and as a standalone `worktree dotfiles [<path>]` subcommand for copying into existing worktrees.

---

## Info Display

`worktree info` shows a unified view:

```
my-branch (review/pr-1234-fix-pagination)
  Path:     ~/git/.worktrees/my-repo/review-pr-1234
  Repo:     my-org/my-repo
  Tracking: origin/my-branch (2 ahead, 0 behind)
  Ports:    4020-4029
  Kube:     ~/.kube/config-my-repo-review-pr-1234

  PR #1234: Fix pagination in list view
    Author: @someone · Created 3 days ago · Updated 1 hour ago
    Status: Open · Review: Changes requested

  Jira: RHOAIENG-5678 — Pagination breaks on page 3
    Type: Bug · Priority: Major · Status: In Progress · Assignee: Someone
  Related:
    ~ RHOAIENG-5600 — List view performance improvements
```

`worktree info --local` skips the PR and Jira API calls (shows only path, repo, tracking, ports, kube, and cached resource keys without enrichment).

When entering a worktree directory, the shell runs `eval "$(worktree env)"` to set environment variables from the database:
```
[wt] my-branch · ~/git/.worktrees/my-repo/review-pr-1234 · ports 4020-4029
```

---

## Phase 2: Web UI

`worktree ui` serves a read-only Mantine + React frontend (`ui/`) from the same Go binary, backed by the Phase 1 database and watcher/resource tables.

**Embed model:** `make build` runs `make build-web` (Vite build into `ui/dist`) before the Go build; `ui/dist` is embedded into the binary via `//go:embed`, so `worktree ui` is a single self-contained executable. `make dev` runs the Go API (`go run . ui --api-only`, no embedded assets served) alongside the Vite dev server (`ui/`, port 5175) for hot-reload iteration, preferring `mprocs` when available.

**Live-update model:** the server runs an in-process poll loop (no external scheduler) that refreshes all actively-watched PR/Jira resources every 2 minutes. A `GET /api/stream` SSE endpoint pushes change notifications to connected browsers so the UI can refetch and stay near-live without a manual reload. Opening a worktree's detail page also triggers an immediate poll if that worktree's data is stale (poll-on-view), rather than waiting for the next tick.

**Views:**
- **Home** (`/`): the list of managed worktrees (from `registry.List`) with resource/primary counts, plus a global timeline merging events across all watched resources, newest-first, each attributed to the worktree(s) that watch it. A "Show archived" toggle includes events for resources no longer actively watched.
- **Detail** (`/worktree/:path`): a single worktree's resources (primary vs. related, matching the `resources` package's model) and a timeline scoped to just that worktree's subscriptions.

This phase is read-only: no create/delete/watch/unwatch mutations from the UI. Slack integration (a Slack tab, slack-mini fold-in, Slack timeline events) and handler↔worktree CLI integration are out of scope here and land in later phases (3–5).
